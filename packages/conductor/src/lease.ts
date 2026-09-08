/**
 * extendLease 心跳模式的版本探测与常量，见 docs/architecture.md §5 与 ADR-0022。
 *
 * **心跳本身不由本项目实现** —— 官方 SDK 的 `LeaseTracker` 已经做好了：
 * 读 `task.responseTimeoutSeconds`，按 ×0.8 的间隔调 `updateTask({ extendLease: true })`，
 * 跑在独立的 100ms 定时器上（并发槽占满也照常心跳）。我们只需要
 * `leaseExtendEnabled: true`，外加这里的版本与取值校验。
 *
 * 为什么是 extendLease 而不是 callback（源码核实）：
 *   ExecutionService.poll 的最后一行是 `tasks.forEach(this::ackTaskReceived)`，
 *   而 ackTaskReceived → queueDAO.ack → `DELETE FROM queue_message`。
 *   **poll 成功之后任务已经从队列里删掉了**，别的 worker 根本看不到它。
 *   extendLease 只刷 updateTime、不碰队列，所以任务从开始到结束都在同一个 worker；
 *   而 callback 每次交还都 postpone 写回队列，下次谁 pop 到就是谁 —— 亲和随之丢失。
 */

/**
 * extendLease 的服务端可用范围（按 conductor-oss/conductor git tag 抽样源码得出）：
 *   v3.10.6 及更早 —— TaskResult 无该字段，服务端无处理逻辑
 *   v3.10.7 起     —— 字段与 WorkflowExecutor 处理逻辑齐备
 */
export const EXTEND_LEASE_MIN_SERVER_VERSION = '3.10.7' as const;

/** 官方 LeaseTracker 的行为常量，仅用于推导 TaskDef 与校验，勿重复实现心跳 */
export const OFFICIAL_LEASE_EXTEND = {
  /** 心跳间隔 = responseTimeoutSeconds × 0.8 */
  durationFactor: 0.8,
  retryCount: 3,
  /** 低于该值算出的间隔 < 1000ms，官方会**跳过不发心跳** —— 任务必然被判超时 */
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

/** 服务端版本不足时拒绝启动，不留到运行期 —— 否则长任务会在第一次 responseTimeout 时被判死 */
export function assertExtendLeaseSupported(serverVersion: string): void {
  if (!supportsExtendLease(serverVersion)) {
    throw new Error(
      `本 SDK 依赖 extendLease 心跳保证「一次执行始终在同一 worker」，` +
        `需要服务端 ≥ ${EXTEND_LEASE_MIN_SERVER_VERSION}，当前为 ${serverVersion}。`,
    );
  }
}

/**
 * 心跳能不能真正发出去，取决于 responseTimeoutSeconds ——
 * 官方 LeaseTracker 在 `intervalMs < 1000` 时**静默跳过**，任务会在
 * responseTimeoutSeconds 之后被判 TIMED_OUT 并消耗一次重试配额。
 * 这类配置错误必须在启动时拒绝，不能等到线上超时才发现。
 */
export function assertHeartbeatViable(responseTimeoutSeconds: number): void {
  if (responseTimeoutSeconds < OFFICIAL_LEASE_EXTEND.minResponseTimeoutSeconds) {
    throw new Error(
      `responseTimeoutSeconds=${responseTimeoutSeconds} 太小：` +
        `官方 LeaseTracker 的心跳间隔是它的 ${OFFICIAL_LEASE_EXTEND.durationFactor} 倍，` +
        `低于 ${OFFICIAL_LEASE_EXTEND.minResponseTimeoutSeconds} 秒时会算出 < 1000ms 的间隔并**跳过不发**，` +
        `任务必然被判 TIMED_OUT。请设为 ≥ ${OFFICIAL_LEASE_EXTEND.minResponseTimeoutSeconds}（建议 60）。`,
    );
  }
}

/** 心跳间隔（毫秒），与官方 LeaseTracker 算法一致，仅供日志与文档展示 */
export function heartbeatIntervalMs(responseTimeoutSeconds: number): number {
  return responseTimeoutSeconds * OFFICIAL_LEASE_EXTEND.durationFactor * 1000;
}
