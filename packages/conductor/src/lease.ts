/**
 * 租约策略与 Fencing，见 docs/architecture.md §5.3、ADR-0007、ADR-0009。占位：仅声明契约。
 *
 * 默认策略是 `callback`（分片执行）。心跳续租不由本项目实现 —— 官方 SDK 的 LeaseTracker
 * 已提供 extendLease 真心跳；本模块只负责：选择策略、决定何时交还任务、版本探测、Fencing。
 */
import type { LeaseRecord } from '@ca/core';

/**
 * extendLease 的服务端可用范围（按 conductor-oss/conductor git tag 抽样源码得出）：
 *   v3.10.6 及更早 —— TaskResult 无该字段，服务端无处理逻辑
 *   v3.10.7 起     —— 字段与 WorkflowExecutor 处理逻辑齐备
 * callbackAfterSeconds 则是 3.x 全系可用，故为默认策略。
 */
export const EXTEND_LEASE_MIN_SERVER_VERSION = '3.10.7' as const;

/** 官方 LeaseTracker 的行为常量，仅用于推导 TaskDef 与断言，勿重复实现心跳 */
export const OFFICIAL_LEASE_EXTEND = {
  /** 心跳间隔 = responseTimeoutSeconds × 0.8 */
  durationFactor: 0.8,
  retryCount: 3,
  /** 低于该值算出的间隔 < 1000ms，官方会跳过心跳 */
  minResponseTimeoutSeconds: 1.25,
} as const;

/**
 * 启动时探测服务端版本；选了 lease-extend / hybrid 而版本不足时拒绝启动，
 * 并提示改用 callback（§6.1）。
 */
export declare function assertExtendLeaseSupported(serverVersion: string): void;

/** 一次 execute() 结束时，桥接层要告诉 Conductor 的事 */
export type LeaseOutcome =
  | { kind: 'finished' }
  /** 本片做完但整体未完成，或在等待外部信号：交还任务并释放槽位 */
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
 * 预算校验（源码核实，见 architecture.md §2.2）：
 *
 * - responseTimeout 判定用 adjustedResponseTimeout = responseTimeoutSeconds + callbackAfterSeconds，
 *   所以 callbackAfterSeconds **不需要**小于 responseTimeoutSeconds。
 * - timeoutSeconds 从 startTime 起算且**不加** callbackAfterSeconds，因此真正的约束是
 *   Σ(所有分片执行 + 所有等待) < timeoutSeconds。本函数据此判断本次交还是否会撞上总超时。
 */
export declare function checkHandbackBudget(args: {
  requestedCallbackAfterSeconds: number;
  taskStartTimeMs: number;
  timeoutSeconds: number;
  now: number;
}): { seconds: number; clamped: boolean; willExceedTotalTimeout: boolean };
