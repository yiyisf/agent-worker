/**
 * 预算治理，见 docs/architecture.md §4.3。
 *
 * 两种模式由引擎的 costVisibility 决定（§4.4）：
 *   per-call  每次模型调用前检查，超了就在调用**前**拦住
 *   per-turn  拦不到单次调用，只能在轮之间结账 —— 单轮内的超支不可控（§15.3 第 2 条）
 */
import type { AgentLimits } from './spec.js';
import type { Usage } from './gateway.js';
import type { BudgetView } from './context.js';
import { BudgetExceededError } from './errors.js';

export interface BudgetSnapshot {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
}

const ZERO: BudgetSnapshot = {
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  toolCalls: 0,
  modelCalls: 0,
};

export class BudgetGovernor implements BudgetView {
  private used: BudgetSnapshot;

  constructor(
    private readonly limits: AgentLimits,
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
    carried: Partial<BudgetSnapshot> = {},
  ) {
    // 跨分片累计：上一分片的用量从 journal 回灌，否则每片都从 0 开始，限额形同虚设
    this.used = { ...ZERO, ...carried };
  }

  get usedInputTokens(): number {
    return this.used.inputTokens;
  }
  get usedOutputTokens(): number {
    return this.used.outputTokens;
  }
  get usedCostUsd(): number {
    return this.used.costUsd;
  }
  get elapsedMs(): number {
    return this.now() - this.startedAt;
  }
  snapshot(): BudgetSnapshot {
    return { ...this.used };
  }

  remaining(metric: 'tokens' | 'cost' | 'time' | 'toolCalls'): number {
    switch (metric) {
      case 'tokens': {
        const cap = this.limits.maxTotalTokens;
        return cap === undefined ? Infinity : cap - (this.used.inputTokens + this.used.outputTokens);
      }
      case 'cost': {
        const cap = this.limits.maxCostUsd;
        return cap === undefined ? Infinity : cap - this.used.costUsd;
      }
      case 'time': {
        const cap = this.limits.wallClockMs;
        return cap === undefined ? Infinity : cap - this.elapsedMs;
      }
      case 'toolCalls': {
        const cap = this.limits.maxToolCalls;
        return cap === undefined ? Infinity : cap - this.used.toolCalls;
      }
    }
  }

  /** 执行前检查。任一维度已耗尽即抛，调用方不必逐项判断。 */
  assertAvailable(kind: 'model' | 'tool'): void {
    for (const metric of ['tokens', 'cost', 'time'] as const) {
      if (this.remaining(metric) <= 0) throw new BudgetExceededError(metric);
    }
    if (kind === 'tool' && this.remaining('toolCalls') <= 0) {
      throw new BudgetExceededError('toolCalls');
    }
  }

  /** 记账。重放命中 journal 时也要记 —— 那笔钱在上一次尝试里已经花掉了。 */
  chargeModel(usage: Usage): void {
    this.used.modelCalls += 1;
    this.used.inputTokens += usage.inputTokens;
    this.used.outputTokens += usage.outputTokens;
    this.used.costUsd += usage.costUsd ?? 0;
  }

  chargeTool(): void {
    this.used.toolCalls += 1;
  }
}
