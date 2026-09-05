/**
 * 分片驱动器：跑引擎的一轮，并把 journal / 预算 / fencing 接上。
 * 见 docs/architecture.md §5.1、§5.3、ADR-0012、ADR-0015、ADR-0016。
 *
 * core 不拥有循环 —— 这里只负责「装好受管入口，让引擎跑一轮，把结果落成 journal」。
 */
import type { AgentSpec, JsonValue } from './spec.js';
import type { AwaitingSpec, BuiltAgent, SliceBudget } from './engine.js';
import type { RunContext } from './context.js';
import type { JournalEntry, LeaseRecord, SerializedError, StateStore } from './journal.js';
import type { ProgressReport } from './progress.js';
import { hasTerminalEntry } from './journal.js';
import { BudgetGovernor, type BudgetSnapshot } from './budget.js';
import { createGateways, RunJournal, serializeError, type FlushPolicy } from './gateway.js';
import { CaError, FencedOutError } from './errors.js';
import { sha256 } from './hash.js';

export type SliceOutcome =
  | { kind: 'done'; output: JsonValue; budget: BudgetSnapshot; sliceIndex: number }
  | { kind: 'continue'; budget: BudgetSnapshot; sliceIndex: number }
  | {
      kind: 'suspended';
      awaiting: AwaitingSpec;
      resumeToken: string;
      budget: BudgetSnapshot;
      sliceIndex: number;
    }
  | { kind: 'failed'; error: SerializedError; budget: BudgetSnapshot; sliceIndex: number };

export interface RunSliceOptions {
  spec: AgentSpec;
  agent: BuiltAgent;
  input: JsonValue;
  ctx: RunContext;
  store: StateStore;
  lease: LeaseRecord;
  /** 覆盖由 limits 推导的分片预算 */
  sliceBudget?: Partial<SliceBudget>;
  flushPolicy?: FlushPolicy;
  /** onAmbiguousReplay='probe' 时必需 */
  probe?: (toolName: string, idempotencyKey: string) => Promise<{ applied: boolean; output?: JsonValue }>;
  /** 恢复时回灌给引擎的外部结果（如审批决定） */
  resumeWith?: JsonValue;
  onProgress?: (r: ProgressReport) => void;
  /**
   * 生成 resumeToken。默认是**未签名**的不透明串，仅够本地串联；
   * 对外暴露 resume 端点前必须换成带签名与过期时间的实现（§7.4）。
   */
  mintResumeToken?: (args: { runKey: string; fenceToken: number; seq: number }) => string;
}

const ZERO_BUDGET: BudgetSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  toolCalls: 0,
  modelCalls: 0,
};

function unsignedResumeToken(a: { runKey: string; fenceToken: number; seq: number }): string {
  return `unsigned.${sha256(`${a.runKey}:${a.fenceToken}:${a.seq}`).slice(0, 32)}`;
}

/** 从 journal 还原上一分片留下的状态、累计用量与分片序号 */
function restore(history: readonly JournalEntry[]): {
  state?: JsonValue | undefined;
  budget: BudgetSnapshot;
  sliceIndex: number;
} {
  let state: JsonValue | undefined;
  let budget = ZERO_BUDGET;
  let sliceIndex = 0;
  for (const e of history) {
    if (e.kind === 'slice') {
      state = e.state;
      budget = e.budget;
      sliceIndex = e.index + 1;
    } else if (e.kind === 'suspend') {
      state = e.state;
      budget = e.budget;
    }
  }
  return { state, budget, sliceIndex };
}

function deriveSliceBudget(spec: AgentSpec, override?: Partial<SliceBudget>): SliceBudget {
  const sliceMs = spec.limits?.sliceMs ?? 60_000;
  return {
    wallClockMs: sliceMs,
    maxModelCalls: 32,
    maxToolCalls: 64,
    ...override,
  };
}

/**
 * 跑一个分片。返回的 SliceOutcome 由桥接层翻译成 Conductor 的任务状态（§6.2）。
 *
 * 重入是安全的：journal 里已有终态时直接返回该终态，不会重跑。
 */
export async function runSlice(opts: RunSliceOptions): Promise<SliceOutcome> {
  const { spec, agent, ctx, store, lease } = opts;
  const history = await store.readJournal(ctx.runKey);

  // 幂等重入：已经有终态就直接给回去
  const terminal = history.find((e) => e.kind === 'final' || e.kind === 'failed');
  if (terminal) {
    const { sliceIndex } = restore(history);
    return terminal.kind === 'final'
      ? { kind: 'done', output: terminal.output, budget: terminal.budget, sliceIndex }
      : { kind: 'failed', error: terminal.error, budget: terminal.budget, sliceIndex };
  }

  const restored = restore(history);
  const journal = new RunJournal(history, (entries) => store.appendJournal(lease, entries));
  const budget = new BudgetGovernor(spec.limits ?? {}, ctx.startedAt, () => Date.now(), restored.budget);
  const { model, tools } = createGateways(journal, {
    budget,
    toolPolicies: spec.toolPolicies ?? {},
    emit: (e) => ctx.emit(e),
    ...(opts.probe ? { probe: opts.probe } : {}),
    ...(opts.flushPolicy ? { flushPolicy: opts.flushPolicy } : {}),
  });

  if (opts.resumeWith !== undefined) {
    journal.append({ kind: 'resume', payload: opts.resumeWith });
    await journal.flush();
  }

  const sliceIndex = restored.sliceIndex;
  ctx.emit({ type: 'slice.started', index: sliceIndex });

  const report = (phase: string): void => {
    const snap = budget.snapshot();
    opts.onProgress?.({
      phase,
      step: snap.modelCalls + snap.toolCalls,
      usage: { tokens: snap.inputTokens + snap.outputTokens, costUsd: snap.costUsd },
      sliceIndex,
      updatedAt: Date.now(),
    });
  };

  try {
    const turn = await agent.run({
      input: opts.input,
      ...(restored.state !== undefined ? { state: restored.state } : {}),
      ...(opts.resumeWith !== undefined ? { resumeWith: opts.resumeWith } : {}),
      budget: deriveSliceBudget(spec, opts.sliceBudget),
      ctx,
      gateways: { model, tools },
    });

    const snap = budget.snapshot();
    if (turn.kind === 'done') {
      journal.append({ kind: 'final', output: turn.output, budget: snap });
      await journal.flush();
      report('done');
      return { kind: 'done', output: turn.output, budget: snap, sliceIndex };
    }

    if (turn.kind === 'continue') {
      journal.append({ kind: 'slice', index: sliceIndex, state: turn.state, budget: snap });
      await journal.flush();
      report('continue');
      return { kind: 'continue', budget: snap, sliceIndex };
    }

    const mint = opts.mintResumeToken ?? unsignedResumeToken;
    const resumeToken = mint({
      runKey: ctx.runKey,
      fenceToken: lease.fenceToken,
      seq: journal.entries().length,
    });
    journal.append({
      kind: 'suspend',
      awaiting: turn.awaiting as unknown as JsonValue,
      resumeToken,
      state: turn.state,
      budget: snap,
    });
    await journal.flush();
    report(`suspended:${turn.awaiting.kind}`);
    return { kind: 'suspended', awaiting: turn.awaiting, resumeToken, budget: snap, sliceIndex };
  } catch (err) {
    // fence 落后就是别人接管了，不能再写任何东西，直接上抛让桥接层放弃回写
    if (err instanceof FencedOutError) throw err;

    const error = serializeError(err);
    const snap = budget.snapshot();

    // ⚠️ ADR-0016：只有**终局**错误才写终态条目。
    // 瞬时错误不写 —— 下次重试要能从 journal 接着跑，而不是被当成业务失败从头再来。
    if (!error.retryable) {
      journal.append({ kind: 'failed', error, budget: snap });
      await journal.flush();
    } else {
      await journal.flush();
    }
    return { kind: 'failed', error, budget: snap, sliceIndex };
  }
}

/**
 * 恢复判据（ADR-0016）：区分「worker 半路没了」与「业务上真失败了」。
 * 不看 Conductor 的 retryCount —— 那两种情况都会 +1，分不出来。
 */
export function decideResume(
  history: readonly JournalEntry[],
  resumePolicy: 'on-lease-loss' | 'fresh-per-retry' | 'never',
): { action: 'continue' | 'restart'; reason: string } {
  if (resumePolicy === 'never') {
    return { action: 'restart', reason: 'resumePolicy=never，不落 journal' };
  }
  if (history.length === 0) {
    return { action: 'restart', reason: '没有历史，首次执行' };
  }
  if (!hasTerminalEntry(history)) {
    return {
      action: 'continue',
      reason: 'journal 无终态条目 → worker 半路没了（崩溃 / 被 kill / 租约超时），续跑',
    };
  }
  return resumePolicy === 'fresh-per-retry'
    ? { action: 'restart', reason: 'journal 有终态 → 业务失败，resumePolicy=fresh-per-retry' }
    : { action: 'continue', reason: 'journal 有终态 → 业务失败，resumePolicy=on-lease-loss 仍续跑' };
}

export { CaError };
