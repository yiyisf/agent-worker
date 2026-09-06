/**
 * 租约策略与交还预算，见 docs/architecture.md §5.3、ADR-0007、ADR-0009。
 *
 * 默认策略是 callback（分片执行）。心跳续租不由本项目实现 —— 官方 SDK 的 LeaseTracker
 * 已提供 extendLease 真心跳；本模块只负责：版本探测、决定交还多久、以及 fencing 的错误类型。
 */
import { FencedOutError } from '@ca/core';

export { FencedOutError };

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

function parseVersion(v: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function supportsExtendLease(serverVersion: string): boolean {
  const [a, b, c] = parseVersion(serverVersion);
  const [x, y, z] = parseVersion(EXTEND_LEASE_MIN_SERVER_VERSION);
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c >= z;
}

/**
 * 选了 lease-extend / hybrid 而服务端版本不足时拒绝启动，并提示改用 callback（§6.1）。
 * 拒绝发生在启动时，不留到运行期。
 */
export function assertExtendLeaseSupported(serverVersion: string): void {
  if (!supportsExtendLease(serverVersion)) {
    throw new Error(
      `leaseStrategy 需要服务端 extendLease 支持（≥ ${EXTEND_LEASE_MIN_SERVER_VERSION}），` +
        `当前服务端为 ${serverVersion}。请改用 leaseStrategy='callback'（Conductor 3.x 全系可用）。`,
    );
  }
}

/** 一次 execute() 结束时，桥接层要告诉 Conductor 的事 */
export type LeaseOutcome =
  | { kind: 'finished' }
  /** 本片做完但整体未完成，或在等待外部信号：交还任务并释放槽位 */
  | { kind: 'handback'; callbackAfterSeconds: number; reason: string };

/**
 * 交还预算校验（源码核实，见 architecture.md §2.2）：
 *
 * - responseTimeout 判定用 adjustedResponseTimeout = responseTimeoutSeconds + callbackAfterSeconds，
 *   所以 callbackAfterSeconds **不需要**小于 responseTimeoutSeconds。
 * - timeoutSeconds 从 startTime 起算且**不加** callbackAfterSeconds，因此真正的约束是
 *   Σ(所有分片执行 + 所有等待) < timeoutSeconds。本函数据此判断本次交还会不会撞上总超时。
 */
export function checkHandbackBudget(args: {
  requestedCallbackAfterSeconds: number;
  taskStartTimeMs: number;
  timeoutSeconds: number;
  now: number;
}): { seconds: number; clamped: boolean; willExceedTotalTimeout: boolean } {
  const requested = Math.max(0, Math.floor(args.requestedCallbackAfterSeconds));
  if (args.timeoutSeconds <= 0 || args.taskStartTimeMs <= 0) {
    return { seconds: requested, clamped: false, willExceedTotalTimeout: false };
  }
  const elapsedSeconds = Math.max(0, (args.now - args.taskStartTimeMs) / 1000);
  const remaining = args.timeoutSeconds - elapsedSeconds;

  if (remaining <= 0) {
    return { seconds: 0, clamped: true, willExceedTotalTimeout: true };
  }
  if (requested >= remaining) {
    // 留一点余量给下一片的执行，否则一醒来就撞上总超时
    const seconds = Math.max(1, Math.floor(remaining * 0.8));
    return { seconds, clamped: true, willExceedTotalTimeout: true };
  }
  return { seconds: requested, clamped: false, willExceedTotalTimeout: false };
}
