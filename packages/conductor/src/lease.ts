/**
 * 租约策略与 Fencing，见 docs/architecture.md §5.3 与 ADR-0007。占位：仅声明契约。
 *
 * 与 v0.1 的差异：心跳续租不再由本项目实现 —— 官方 SDK 的 LeaseTracker 已提供
 * `extendLease: true` 真心跳（只重置 responseTimeoutSeconds，不把任务放回队列）。
 * 本模块只负责：选择策略、决定何时交还任务、以及 Fencing。
 */
import type { LeaseRecord } from '@ca/core';

/** 官方 LeaseTracker 的行为常量，仅用于推导 TaskDef 与断言，勿重复实现心跳 */
export const OFFICIAL_LEASE_EXTEND = {
  /** 心跳间隔 = responseTimeoutSeconds × 0.8 */
  durationFactor: 0.8,
  /** 心跳失败重试次数 */
  retryCount: 3,
  /** 低于该值算出的间隔 < 1000ms，官方会跳过心跳 */
  minResponseTimeoutSeconds: 1.25,
} as const;

/** 一次 execute() 结束时，桥接层要告诉 Conductor 的事 */
export type LeaseOutcome =
  | { kind: 'finished' }
  /** 交还任务并释放槽位；callbackAfterSeconds 必须 < TaskDef.timeoutSeconds */
  | { kind: 'handback'; callbackAfterSeconds: number; reason: string };

export interface LeaseGuard {
  /** 抢占 runKey 的执行权；失败表示已有更新的 owner，本 worker 应立即放弃 */
  acquire(runKey: string): Promise<LeaseRecord | undefined>;
  /** 每次写 journal / 回写 Conductor 前校验 fenceToken 是否仍然有效 */
  assertValid(lease: LeaseRecord): Promise<void>;
  release(lease: LeaseRecord): Promise<void>;
}

export class FencedOutError extends Error {
  constructor(readonly runKey: string, readonly ownFence: number, readonly currentFence: number) {
    super(`run ${runKey} fenced out: own=${ownFence} current=${currentFence}`);
    this.name = 'FencedOutError';
  }
}

/**
 * callbackAfterSeconds 超过 timeoutSeconds 会让任务被判 TIMED_OUT（ADR-0007「已知陷阱」）。
 * 编译期与运行期各校验一次；运行期超限则夹到 timeoutSeconds × 0.8 并告警。
 */
export declare function clampCallbackAfterSeconds(
  requested: number,
  timeoutSeconds: number,
): { seconds: number; clamped: boolean };
