/**
 * 由预算反压驱动的准入控制，见 docs/architecture.md §6.2。
 * 关键点：槽位为 0 时不 poll，避免拉走任务后卡在限流上空耗租约。
 * 占位：仅声明契约。
 */
import type { ConductorTask } from './client.js';

export interface AdmissionSignal {
  /** 当前可安全承接的运行数上限 */
  availableSlots(): number;
}

export interface PollSubscription {
  taskType: string;
  domain?: string;
  batchSize: number;
  weight?: number;
}

export interface PollManagerOptions {
  workerId: string;
  subscriptions: PollSubscription[];
  longPollTimeoutMs?: number;
  idleBackoff?: { initialMs: number; maxMs: number };
  admission: AdmissionSignal[];
}

export interface PollManager {
  start(handler: (task: ConductorTask) => Promise<void>): void;
  /** 停止 poll，等待运行中的任务收敛（或按 yield 策略主动交还） */
  shutdown(opts?: { graceMs?: number }): Promise<void>;
}
