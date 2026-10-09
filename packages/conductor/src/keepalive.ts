/**
 * 分片内保活，见 docs/architecture.md §5.3 与 ADR-0024。
 *
 * 参数移植自 Claude Projects 版 ca-worker 的 planHeartbeat，依据 §2.3 #1 实测：
 * - IN_PROGRESS 更新会把队列消息推迟 callbackAfterSeconds；取 0 或小于心跳周期时，
 *   同一 taskId 每次心跳后都能被其他 worker 拉到 → in-progress 模式取 callbackAfterSeconds = responseTimeoutSeconds；
 * - 间隔 = max(5s, responseTimeoutSeconds × 0.4)，且必须 ≤ callbackAfterSeconds × 0.4；
 * - 连续 2 次失败即中止本次运行，赶在任务被他人接管前停下。
 *
 * 不用官方 LeaseTracker（leaseExtendEnabled）：4.0.0 中其间隔为 0.8 倍、失败只记日志不中止，
 * 不满足 Fencing 的要求。
 */

/**
 * extend-lease：IN_PROGRESS + extendLease: true，不碰队列（需服务端 ≥ 3.10.7；待 contract-verify 实测）
 * in-progress： IN_PROGRESS + callbackAfterSeconds = responseTimeoutSeconds（已实测）
 */
export type KeepaliveMode = 'extend-lease' | 'in-progress';

export interface KeepalivePlan {
  mode: KeepaliveMode;
  intervalSeconds: number;
  /** in-progress 模式下每次保活携带的值；extend-lease 模式下不发送，仅作为间隔约束的基准 */
  callbackAfterSeconds: number;
  maxConsecutiveFailures: number;
}

export const MIN_KEEPALIVE_INTERVAL_SECONDS = 5;
export const KEEPALIVE_RATIO = 0.4;
export const MAX_CONSECUTIVE_KEEPALIVE_FAILURES = 2;
/** 满足 max(5, rt × 0.4) ≤ rt × 0.4 的最小 responseTimeoutSeconds */
export const MIN_RESPONSE_TIMEOUT_FOR_KEEPALIVE = Math.ceil(MIN_KEEPALIVE_INTERVAL_SECONDS / KEEPALIVE_RATIO);

export function planKeepalive(responseTimeoutSeconds: number, mode: KeepaliveMode = 'extend-lease'): KeepalivePlan {
  if (!Number.isInteger(responseTimeoutSeconds) || responseTimeoutSeconds <= 0) {
    throw new Error(`responseTimeoutSeconds 必须是正整数，当前为 ${responseTimeoutSeconds}`);
  }
  const callbackAfterSeconds = responseTimeoutSeconds;
  const intervalSeconds = Math.max(
    MIN_KEEPALIVE_INTERVAL_SECONDS,
    Math.floor(responseTimeoutSeconds * KEEPALIVE_RATIO),
  );
  if (intervalSeconds > callbackAfterSeconds * KEEPALIVE_RATIO) {
    throw new Error(
      `responseTimeoutSeconds=${responseTimeoutSeconds} 过小：保活间隔 ${intervalSeconds}s 超过 callbackAfterSeconds 的 ${KEEPALIVE_RATIO} 倍，请至少设为 ${MIN_RESPONSE_TIMEOUT_FOR_KEEPALIVE}s`,
    );
  }
  return { mode, intervalSeconds, callbackAfterSeconds, maxConsecutiveFailures: MAX_CONSECUTIVE_KEEPALIVE_FAILURES };
}

/**
 * ADR-0024 不变量 4：执行期间任何 IN_PROGRESS 更新的 callbackAfterSeconds 不得小于保活间隔，
 * 否则同一 taskId 会在下一次保活前被他人拉到（§2.3 #1）。
 * 分片交还时的 callbackAfterSeconds 是「等待时长」，执行已停止，由 checkHandbackBudget 另行约束。
 */
export function assertSafeInProgressCallbackAfter(callbackAfterSeconds: number, plan: KeepalivePlan): void {
  if (callbackAfterSeconds < plan.intervalSeconds) {
    throw new Error(
      `执行期间的 IN_PROGRESS 更新 callbackAfterSeconds=${callbackAfterSeconds} 小于保活间隔 ${plan.intervalSeconds}s，会导致同一任务被重复投递`,
    );
  }
}

/** 保活定时器契约。M1 实现。 */
export interface Keepalive {
  /** 执行开始时启动；连续失败达到上限时 abort 传入的 controller */
  start(args: { taskId: string; workflowInstanceId: string; workerId: string; abort: AbortController }): void;
  /** 分片交还或终态上报前停止，避免与最终更新交错 */
  stop(): Promise<void>;
}
