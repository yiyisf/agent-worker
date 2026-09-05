/** 运行上下文，见 docs/architecture.md §4.8。占位：仅声明契约。 */
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
  retryCount: number;
}

export interface RunContext {
  /** 恢复锚点：`${workflowInstanceId}:${taskReferenceName}:${epoch}`（§5.2） */
  readonly runKey: string;
  readonly runId: string;
  readonly attempt: number;
  /** callback 分片序号，从 0 开始 */
  readonly sliceIndex: number;
  readonly tenantId?: string;
  readonly source?: ConductorSource;

  /** 本次 run 的起点（跨分片保持不变），预算的时间维度以它为基准 */
  readonly startedAt: number;
  readonly deadline: number;
  /** 取消 / 超时 / 预算耗尽统一经由此 signal 传播 */
  readonly signal: AbortSignal;

  readonly logger: Logger;
  readonly budget: BudgetView;
  readonly secrets: SecretProvider;

  emit(event: AgentEvent): void;
}
