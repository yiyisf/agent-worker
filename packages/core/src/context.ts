/** 运行上下文，见 docs/architecture.md §4.8。 */
import type { AgentEvent } from './events.js';

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface BudgetView {
  usedInputTokens: number;
  usedOutputTokens: number;
  usedCostUsd: number;
  elapsedMs: number;
  remaining(metric: 'tokens' | 'cost' | 'time' | 'toolCalls'): number;
}

export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
}

/** Conductor 溯源信息；非 Conductor 宿主下为 undefined */
export interface ConductorSource {
  workflowInstanceId: string;
  workflowName: string;
  taskId: string;
  taskReferenceName: string;
  correlationId?: string;
  /** Conductor 的重试次数。>0 说明这是重试，previousAttempt 里有上次的 outputData */
  retryCount: number;
}

export interface RunContext {
  /**
   * 本次运行的标识 —— 就是 Conductor 的 **taskId**（ADR-0020）。
   * 同一次执行的多次 callback 共享它；重试或新工作流实例则是新的。
   */
  readonly runId: string;
  /** Conductor 的 retryCount */
  readonly attempt: number;
  readonly tenantId?: string;
  readonly source?: ConductorSource;

  /** 本次运行的起点，预算的时间维度以它为基准 */
  readonly startedAt: number;
  /** startedAt + limits.wallClockMs */
  readonly deadline: number;
  /** 取消 / 超时 / 预算耗尽 / 工作流被终止，统一经由此 signal 传播 */
  readonly signal: AbortSignal;

  readonly logger: Logger;
  readonly budget: BudgetView;
  readonly secrets: SecretProvider;

  emit(event: AgentEvent): void;
}
