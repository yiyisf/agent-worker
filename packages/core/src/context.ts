/** 运行上下文，见 docs/architecture.md §4.2。占位：仅声明契约。 */
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
  remaining(metric: 'tokens' | 'cost' | 'time' | 'steps'): number;
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

export interface SuspendRequest {
  reason: string;
  /** 期望多久之后被重新调度（秒） */
  callbackAfterSeconds: number;
  /** 恢复时回灌给循环的上下文键 */
  awaiting?: Record<string, unknown>;
}

export interface RunContext {
  /** 恢复锚点：`${workflowInstanceId}:${taskReferenceName}:${epoch}`，见 §5.2 */
  readonly runKey: string;
  /** 单次物理执行 id，恢复后会变化 */
  readonly runId: string;
  readonly attempt: number;
  readonly tenantId?: string;
  readonly source?: ConductorSource;

  readonly deadline: number;
  /** 取消 / 超时 / 预算耗尽统一经由此 signal 传播 */
  readonly signal: AbortSignal;

  readonly logger: Logger;
  readonly budget: BudgetView;
  readonly secrets: SecretProvider;

  /** 受管的非确定性入口 —— 直接用 Date.now()/Math.random() 会破坏重放（ADR-0003） */
  now(): number;
  random(): number;

  emit(event: AgentEvent): void;
  /** 挂起当前运行，写 journal 并交还控制权（§7.4） */
  suspend(req: SuspendRequest): never;
}
