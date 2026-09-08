/**
 * 运行驱动器：装好受管入口，让引擎从头跑到完成。见 docs/architecture.md §5.1 与 ADR-0012/0019。
 *
 * core 不拥有循环 —— 这里只负责「装好受管入口、预算、超时，把结果收回来」。
 * agent 的状态自始至终在这一次调用的内存里 —— extendLease 保证它不会中途换 worker（ADR-0022）。
 */
import type { AgentSpec, JsonValue } from './spec.js';
import type { BuiltAgent, RunBudget } from './engine.js';
import type { RunContext } from './context.js';
import type { ProgressReport } from './progress.js';
import type { SerializedError } from './errors.js';
import {
  DEFAULT_MODEL_CALL_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEFAULT_WALL_CLOCK_MS,
} from './spec.js';
import { BudgetGovernor, type BudgetSnapshot } from './budget.js';
import { createGateways } from './gateway.js';
import { CaError, serializeError } from './errors.js';

export type RunOutcome =
  | { kind: 'done'; output: JsonValue; budget: BudgetSnapshot }
  | { kind: 'failed'; error: SerializedError; budget: BudgetSnapshot };

export interface RunAgentOptions {
  spec: AgentSpec;
  agent: BuiltAgent;
  input: JsonValue;
  /** 上一次 attempt 的 outputData，由 Conductor 原生携带（§2.2） */
  previousAttempt?: JsonValue;
  ctx: RunContext;
  /** 覆盖由 limits 推导的运行预算 */
  runBudget?: Partial<RunBudget>;
  onProgress?: (r: ProgressReport) => void;
}

export function deriveRunBudget(spec: AgentSpec, override?: Partial<RunBudget>): RunBudget {
  return {
    wallClockMs: spec.limits?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
    maxModelCalls: 256,
    maxToolCalls: spec.limits?.maxToolCalls ?? 512,
    ...override,
  };
}

/**
 * 跑完一次 agent。返回的 RunOutcome 由桥接层翻译成 Conductor 的任务状态（§6.2）。
 *
 * 只有一种失败：抛异常。`CaError.retryable` 决定它是「交给引擎重试」还是「终局失败」。
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunOutcome> {
  const { spec, agent, ctx } = opts;
  const limits = spec.limits ?? {};
  const budget = new BudgetGovernor(limits, ctx.startedAt);

  const report = (phase: string): void => {
    const s = budget.snapshot();
    opts.onProgress?.({
      phase,
      step: s.modelCalls + s.toolCalls,
      usage: { tokens: s.inputTokens + s.outputTokens, costUsd: s.costUsd },
      updatedAt: Date.now(),
    });
  };

  const gateways = createGateways({
    budget,
    toolPolicies: spec.toolPolicies ?? {},
    emit: (e) => ctx.emit(e),
    onStep: report,
    modelCallTimeoutMs: limits.modelCallTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS,
    toolCallTimeoutMs: limits.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    signal: ctx.signal,
  });

  report('started');

  try {
    const output = await agent.run({
      input: opts.input,
      ...(opts.previousAttempt !== undefined ? { previousAttempt: opts.previousAttempt } : {}),
      budget: deriveRunBudget(spec, opts.runBudget),
      ctx,
      gateways,
    });
    report('done');
    return { kind: 'done', output, budget: budget.snapshot() };
  } catch (err) {
    const error = serializeError(err);
    report('failed');
    return { kind: 'failed', error, budget: budget.snapshot() };
  }
}

export { CaError };
