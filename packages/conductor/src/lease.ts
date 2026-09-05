/**
 * 租约与 Fencing，见 docs/architecture.md §5.3 与 ADR-0004。占位：仅声明契约。
 *
 * 设计前提（待在目标 Conductor 版本实测确认）：
 * Conductor 没有「不释放任务的纯心跳」原语，因此只能在 long-lease 与 yield 之间二选一。
 */
import type { LeaseRecord } from '@ca/core';

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
