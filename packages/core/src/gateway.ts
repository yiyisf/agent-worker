/**
 * 两个受管入口 —— 可靠性的全部作用点，见 docs/architecture.md §4.3 与 ADR-0012。
 *
 * 核心洞察：可靠性不需要拥有循环。模型调用决定**成本**，工具执行决定**副作用**，
 * 循环的其余部分（拼消息、判停止条件）既不花钱也无副作用，没有拦截价值。
 *
 * guard 内部依次执行：
 *   journal 命中检查 → 护栏 → 预算 → 幂等键注入 → 执行 → 写 journal → 事件
 *
 * 恢复 = 重跑引擎循环，但每个受管入口都被 journal 短路：循环照走，不产生真实调用或副作用。
 */
import type { JsonValue, ToolPolicy } from './spec.js';
import type { JournalEntry, JournalEntryInput, SerializedError } from './journal.js';
import type { BudgetGovernor } from './budget.js';
import type { AgentEvent } from './events.js';
import { callKeyOf, stepIdOf } from './hash.js';
import { AmbiguousReplayError, CaError } from './errors.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface ManagedModelGateway {
  /**
   * @param call   引擎原生的请求载荷。对 core 不透明，但必须可 JSON 序列化以便稳定哈希
   * @param invoke 真正的模型调用，仅在 journal 未命中时被执行
   */
  guard<T>(call: JsonValue, invoke: () => Promise<{ result: T; usage: Usage }>): Promise<T>;
}

export interface ManagedToolGateway {
  /** 可能抛 GuardrailBlockedError / BudgetExceededError / AmbiguousReplayError */
  guard<T>(
    toolName: string,
    input: JsonValue,
    invoke: (opts: { idempotencyKey: string }) => Promise<T>,
  ): Promise<T>;
}

/*
 * 注：v0.4 曾在此定义 SuspendSignal —— 通过在受管工具入口抛异常炸开引擎调用栈来实现挂起。
 * v0.5 已删除（ADR-0014）：在别人的代码里抛异常、由别人决定怎么接，本身不可控；
 * 而实测 9 个 harness 适配器里 8 个都有原生两段式审批。挂起统一走引擎原生审批（§4.7）。
 */

/** journal 落盘策略。默认 per-step —— 正确性优先，代价是写放大（§15.3 第 3 条） */
export type FlushPolicy = 'per-step' | 'per-slice';

export interface GatewayDeps {
  budget: BudgetGovernor;
  toolPolicies: Record<string, ToolPolicy>;
  emit: (e: AgentEvent) => void;
  /** onAmbiguousReplay: 'probe' 时必需 */
  probe?: (toolName: string, idempotencyKey: string) => Promise<{ applied: boolean; output?: JsonValue }>;
  flushPolicy?: FlushPolicy;
}

/**
 * 一次 run 的 journal 视图：负责 stepId 分配、命中查找、以及写入缓冲与落盘。
 * 跨分片复用同一个 runKey 的 journal，所以 occurrence 计数要把历史条目算进来。
 */
export class RunJournal {
  private seq = 0;
  private readonly occurrence = new Map<string, number>();
  private readonly byStepId = new Map<string, JournalEntry>();
  /** 有 intent 但没有结果的 stepId —— 模糊重放的判据 */
  private readonly danglingIntents = new Map<string, JournalEntry & { kind: 'tool.intent' }>();
  private buffered: JournalEntry[] = [];

  constructor(
    private readonly history: JournalEntry[],
    private readonly persist: (entries: JournalEntry[]) => Promise<void>,
  ) {
    for (const e of history) {
      this.seq = Math.max(this.seq, e.seq + 1);
      if (e.kind === 'model' || e.kind === 'tool.result' || e.kind === 'tool.error') {
        this.byStepId.set(e.stepId, e);
        this.danglingIntents.delete(e.stepId);
      } else if (e.kind === 'tool.intent') {
        if (!this.byStepId.has(e.stepId)) this.danglingIntents.set(e.stepId, e);
      }
    }
  }

  entries(): readonly JournalEntry[] {
    return [...this.history, ...this.buffered];
  }

  /** 内容键 + 出现次数，见 hash.ts 关于并发安全的说明 */
  nextStepId(kind: 'model' | 'tool', name: string, input: JsonValue): string {
    const callKey = callKeyOf(kind, name, input);
    const occ = this.occurrence.get(callKey) ?? 0;
    this.occurrence.set(callKey, occ + 1);
    return stepIdOf(callKey, occ);
  }

  lookup(stepId: string): JournalEntry | undefined {
    return this.byStepId.get(stepId);
  }

  hasDanglingIntent(stepId: string): boolean {
    return this.danglingIntents.has(stepId);
  }

  append(entry: JournalEntryInput): JournalEntry {
    const full = { ...entry, seq: this.seq++ } as JournalEntry;
    this.buffered.push(full);
    if (full.kind === 'model' || full.kind === 'tool.result' || full.kind === 'tool.error') {
      this.byStepId.set(full.stepId, full);
      this.danglingIntents.delete(full.stepId);
    }
    return full;
  }

  async flush(): Promise<void> {
    if (this.buffered.length === 0) return;
    const pending = this.buffered;
    this.buffered = [];
    try {
      await this.persist(pending);
      this.history.push(...pending);
    } catch (err) {
      // 落盘失败要把缓冲放回去，否则条目静默丢失
      this.buffered = [...pending, ...this.buffered];
      throw err;
    }
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof CaError) {
    return { name: err.name, message: err.message, retryable: err.retryable };
  }
  const e = err as Error;
  return { name: e?.name ?? 'Error', message: e?.message ?? String(err), retryable: true };
}

const DEFAULT_POLICY: ToolPolicy = { effect: 'pure' };

export function createGateways(
  journal: RunJournal,
  deps: GatewayDeps,
): { model: ManagedModelGateway; tools: ManagedToolGateway } {
  const flushPolicy = deps.flushPolicy ?? 'per-step';
  const maybeFlush = async (force: boolean) => {
    if (force || flushPolicy === 'per-step') await journal.flush();
  };

  const model: ManagedModelGateway = {
    async guard<T>(call: JsonValue, invoke: () => Promise<{ result: T; usage: Usage }>): Promise<T> {
      const stepId = journal.nextStepId('model', 'model', call);
      const hit = journal.lookup(stepId);
      if (hit?.kind === 'model') {
        // 重放：不再真的调模型，但用量照记 —— 那笔钱在上一次尝试里已经花掉了
        deps.budget.chargeModel(hit.usage);
        deps.emit({ type: 'model.call', stepId, replayed: true, usage: hit.usage });
        return hit.response as T;
      }

      deps.budget.assertAvailable('model');
      const { result, usage } = await invoke();
      deps.budget.chargeModel(usage);
      journal.append({ kind: 'model', stepId, response: result as JsonValue, usage });
      // 模型响应必须尽快落盘：丢了就意味着重放时要重新付费
      await maybeFlush(true);
      deps.emit({ type: 'model.call', stepId, replayed: false, usage });
      return result;
    },
  };

  const tools: ManagedToolGateway = {
    async guard<T>(
      toolName: string,
      input: JsonValue,
      invoke: (opts: { idempotencyKey: string }) => Promise<T>,
    ): Promise<T> {
      const policy = deps.toolPolicies[toolName] ?? DEFAULT_POLICY;
      const stepId = journal.nextStepId('tool', toolName, input);

      const hit = journal.lookup(stepId);
      if (hit?.kind === 'tool.result') {
        deps.budget.chargeTool();
        deps.emit({ type: 'tool.started', stepId, name: toolName, replayed: true });
        return hit.output as T;
      }
      if (hit?.kind === 'tool.error') {
        deps.budget.chargeTool();
        deps.emit({
          type: 'tool.failed',
          stepId,
          name: toolName,
          error: hit.error.message,
          retryable: hit.error.retryable,
        });
        throw new CaError(hit.error.message, hit.error.retryable);
      }

      // 模糊重放：上次写了 intent 但没写结果，不知道副作用有没有生效（ADR-0005）
      if (journal.hasDanglingIntent(stepId)) {
        const mode = policy.onAmbiguousReplay ?? 'fail';
        if (mode === 'fail') throw new AmbiguousReplayError(toolName, stepId);
        if (mode === 'probe') {
          if (!deps.probe) {
            throw new CaError(`tool "${toolName}" 配置了 onAmbiguousReplay=probe 但未提供 probe 实现`, false);
          }
          const probed = await deps.probe(toolName, stepId);
          if (probed.applied) {
            journal.append({ kind: 'tool.result', stepId, tool: toolName, output: probed.output ?? null });
            await maybeFlush(true);
            deps.budget.chargeTool();
            return (probed.output ?? null) as T;
          }
        }
        // mode === 'retry'，或 probe 判定未生效：继续往下重跑
      }

      deps.budget.assertAvailable('tool');

      // 非 pure 工具必须**先把 intent 落盘再执行**，否则执行后崩溃就查无痕迹，
      // 重放会当成从未执行过而重跑一次（ADR-0005 的整个机制依赖这个顺序）
      if (policy.effect !== 'pure') {
        journal.append({ kind: 'tool.intent', stepId, tool: toolName, input, effect: policy.effect });
        await maybeFlush(true);
      }

      deps.emit({ type: 'tool.started', stepId, name: toolName, replayed: false });
      const startedAt = Date.now();
      try {
        const output = await invoke({ idempotencyKey: stepId });
        deps.budget.chargeTool();
        journal.append({ kind: 'tool.result', stepId, tool: toolName, output: output as JsonValue });
        await maybeFlush(policy.effect !== 'pure');
        deps.emit({ type: 'tool.succeeded', stepId, name: toolName, durationMs: Date.now() - startedAt });
        return output;
      } catch (err) {
        const error = serializeError(err);
        deps.budget.chargeTool();
        journal.append({ kind: 'tool.error', stepId, tool: toolName, error });
        await maybeFlush(policy.effect !== 'pure');
        deps.emit({
          type: 'tool.failed',
          stepId,
          name: toolName,
          error: error.message,
          retryable: error.retryable,
        });
        throw err;
      }
    },
  };

  return { model, tools };
}
