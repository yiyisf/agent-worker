/**
 * 两个受管入口 —— 可靠性的全部作用点，见 docs/architecture.md §4.3 与 ADR-0012。
 *
 * 核心洞察：可靠性不需要拥有循环。模型调用决定**成本**，工具执行决定**副作用**，
 * 循环的其余部分（拼消息、判停止条件）既不花钱也无副作用，没有拦截价值。
 *
 * guard 内部依次执行：预算闸门 → 超时闸门 → 幂等键注入 → 执行 → 记账 → 事件。
 *
 * ⚠️ 这里**没有 journal**（ADR-0019）。一次运行从头跑到完成，不存在「重放」这回事，
 * journal 的短路语义没有作用点。
 * 崩溃后的处理是整次运行重来（ADR-0021），代价与收益都写在那份 ADR 里。
 */
import type { JsonValue, ToolPolicy } from './spec.js';
import type { BudgetGovernor } from './budget.js';
import type { AgentEvent } from './events.js';
import { callKeyOf, stepIdOf } from './hash.js';
import { CallTimeoutError, serializeError } from './errors.js';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface ManagedModelGateway {
  /**
   * @param call   引擎原生的请求载荷。对 core 不透明，但必须可 JSON 序列化以便稳定哈希
   * @param invoke 真正的模型调用
   */
  guard<T>(call: JsonValue, invoke: () => Promise<{ result: T; usage: Usage }>): Promise<T>;
}

export interface ManagedToolGateway {
  /** 可能抛 GuardrailBlockedError / BudgetExceededError / CallTimeoutError */
  guard<T>(
    toolName: string,
    input: JsonValue,
    invoke: (opts: { idempotencyKey: string }) => Promise<T>,
  ): Promise<T>;
}

export interface GatewayDeps {
  budget: BudgetGovernor;
  toolPolicies: Record<string, ToolPolicy>;
  emit: (e: AgentEvent) => void;
  /** 每完成一次受管调用回调一次，供上层生成进展（§10.4） */
  onStep?: (phase: string) => void;
  modelCallTimeoutMs: number;
  toolCallTimeoutMs: number;
  /** 整次运行的取消信号（超时 / 工作流被终止） */
  signal?: AbortSignal;
}

const DEFAULT_POLICY: ToolPolicy = { effect: 'pure' };

/** 竞速超时。不中断底层调用本身 —— 那是引擎/SDK 的职责，这里只保证不无限期挂住 */
async function withTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
  kind: 'model' | 'tool',
  name: string,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CallTimeoutError(kind, name, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 幂等键：内容哈希 + 本次运行内的出现序号。
 *
 * 用内容而非顺序作键，是因为引擎会**并发**执行工具 —— 顺序号在并发下不稳定。
 * 键本身不用于短路（没有 journal 了），而是传给工具实现，让下游系统自己做去重。
 */
class StepKeys {
  private readonly occurrence = new Map<string, number>();
  next(kind: 'model' | 'tool', name: string, input: JsonValue): string {
    const callKey = callKeyOf(kind, name, input);
    const occ = this.occurrence.get(callKey) ?? 0;
    this.occurrence.set(callKey, occ + 1);
    return stepIdOf(callKey, occ);
  }
}

export function createGateways(deps: GatewayDeps): {
  model: ManagedModelGateway;
  tools: ManagedToolGateway;
} {
  const keys = new StepKeys();

  const model: ManagedModelGateway = {
    async guard<T>(call: JsonValue, invoke: () => Promise<{ result: T; usage: Usage }>): Promise<T> {
      deps.signal?.throwIfAborted();
      deps.budget.assertAvailable('model');
      const stepId = keys.next('model', 'model', call);

      const { result, usage } = await withTimeout(invoke(), deps.modelCallTimeoutMs, 'model', 'model');
      deps.budget.chargeModel(usage);
      deps.emit({ type: 'model.call', stepId, usage });
      deps.onStep?.('model');
      return result;
    },
  };

  const tools: ManagedToolGateway = {
    async guard<T>(
      toolName: string,
      input: JsonValue,
      invoke: (opts: { idempotencyKey: string }) => Promise<T>,
    ): Promise<T> {
      deps.signal?.throwIfAborted();
      const policy = deps.toolPolicies[toolName] ?? DEFAULT_POLICY;
      deps.budget.assertAvailable('tool');
      const stepId = keys.next('tool', toolName, input);
      const timeoutMs = policy.timeoutMs ?? deps.toolCallTimeoutMs;

      deps.emit({ type: 'tool.started', stepId, name: toolName });
      const startedAt = Date.now();
      try {
        const output = await withTimeout(
          invoke({ idempotencyKey: stepId }),
          timeoutMs,
          'tool',
          toolName,
        );
        deps.budget.chargeTool();
        deps.emit({ type: 'tool.succeeded', stepId, name: toolName, durationMs: Date.now() - startedAt });
        deps.onStep?.(`tool:${toolName}`);
        return output;
      } catch (err) {
        const error = serializeError(err);
        deps.budget.chargeTool();
        // effectful 工具超时最危险：副作用可能已生效但我们不知道。据实标注，交给上层决定
        const ambiguous = err instanceof CallTimeoutError && policy.effect === 'effectful';
        deps.emit({
          type: 'tool.failed',
          stepId,
          name: toolName,
          error: ambiguous ? `${error.message}（effectful 工具超时，副作用是否生效未知）` : error.message,
          retryable: ambiguous ? false : error.retryable,
        });
        deps.onStep?.(`tool:${toolName}:failed`);
        throw err;
      }
    },
  };

  return { model, tools };
}

export { serializeError };
export type { SerializedError } from './errors.js';
