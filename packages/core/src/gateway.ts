/**
 * 两个受管入口 —— 可靠性的全部作用点，见 docs/architecture.md §4.3 与 ADR-0012。
 * 占位：仅声明契约。
 *
 * 核心洞察：可靠性不需要拥有循环。模型调用决定**成本**，工具执行决定**副作用**，
 * 循环的其余部分（拼消息、判停止条件）既不花钱也无副作用，没有拦截价值。
 *
 * guard 内部依次执行：
 *   journal 命中检查 → 护栏 → 预算 → 幂等键注入 → 执行 → 写 journal → span/指标
 *
 * 恢复 = 重跑引擎循环，但每个受管入口都被 journal 短路：循环照走，不产生真实调用或副作用。
 */
import type { JsonValue } from './spec.js';

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
  /** 可能抛 GuardrailBlockedError / BudgetExceededError */
  guard<T>(toolName: string, input: JsonValue, invoke: () => Promise<T>): Promise<T>;
}

/*
 * 注：v0.4 曾在此定义 SuspendSignal —— 通过在受管工具入口抛异常炸开引擎调用栈来实现挂起。
 * v0.5 已删除（ADR-0014）：在别人的代码里抛异常、由别人决定怎么接，本身不可控；
 * 而实测 9 个 harness 适配器里 8 个都有原生两段式审批。挂起统一走引擎原生审批（§4.7）。
 */

export class BudgetExceededError extends Error {
  constructor(readonly metric: 'tokens' | 'cost' | 'time' | 'toolCalls') {
    super(`budget exceeded: ${metric}`);
    this.name = 'BudgetExceededError';
  }
}

export class GuardrailBlockedError extends Error {
  constructor(readonly rule: string, readonly terminal: boolean) {
    super(`blocked by guardrail: ${rule}`);
    this.name = 'GuardrailBlockedError';
  }
}
