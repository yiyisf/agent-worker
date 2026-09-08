/**
 * 取消检测，见 docs/architecture.md §6.4（对应约束 C3）。
 *
 * Conductor 不推送取消，官方 SDK 也不提供，因此这部分由本项目自持：
 * 轮询工作流状态，同工作流的多个 run 合并为一次请求（用官方 WorkflowClient 发请求）。
 */

export interface CancellationWatcherOptions {
  /** 查询工作流状态；由调用方注入官方 WorkflowClient 的调用 */
  getStatus: (workflowInstanceId: string) => Promise<string>;
  /** 查询结果的缓存时长，默认 15_000 —— 同工作流的并发 run 只发一次请求 */
  cacheMs?: number;
  /** 视为「应当中止」的工作流状态 */
  abortOn?: readonly string[];
}

const DEFAULT_ABORT_ON = ['TERMINATED', 'TIMED_OUT', 'FAILED', 'COMPLETED'] as const;

/**
 * 返回一个 isWorkflowCancelled 函数，可直接传给 compileAgentWorker。
 * 查询失败不当作已取消 —— 网络抖动不该让正常运行的 Agent 被判死。
 */
export function createCancellationWatcher(opts: CancellationWatcherOptions): {
  isWorkflowCancelled: (workflowInstanceId: string) => Promise<boolean>;
} {
  const cacheMs = opts.cacheMs ?? 15_000;
  const abortOn = new Set<string>(opts.abortOn ?? DEFAULT_ABORT_ON);
  const cache = new Map<string, { at: number; cancelled: boolean }>();
  const inflight = new Map<string, Promise<boolean>>();

  return {
    async isWorkflowCancelled(workflowInstanceId: string): Promise<boolean> {
      const hit = cache.get(workflowInstanceId);
      const now = Date.now();
      if (hit && now - hit.at < cacheMs) return hit.cancelled;

      // 合并同工作流的并发查询
      const existing = inflight.get(workflowInstanceId);
      if (existing) return existing;

      const p = (async () => {
        try {
          const status = await opts.getStatus(workflowInstanceId);
          const cancelled = abortOn.has(status);
          cache.set(workflowInstanceId, { at: Date.now(), cancelled });
          return cancelled;
        } catch {
          // 查不到不等于被取消
          return false;
        } finally {
          inflight.delete(workflowInstanceId);
        }
      })();
      inflight.set(workflowInstanceId, p);
      return p;
    },
  };
}
