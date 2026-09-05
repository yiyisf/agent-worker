/**
 * 取消检测，见 docs/architecture.md §6.5。
 * Conductor 不推送取消，只能轮询工作流状态；同工作流的多个 run 合并为一次请求。
 * 占位：仅声明契约。
 */
export interface CancellationWatcherOptions {
  /** 运行超过该时长才开始监视，默认 20_000 */
  activateAfterMs?: number;
  /** 轮询间隔，默认 15_000 */
  intervalMs?: number;
  /** 视为「应当中止」的工作流状态 */
  abortOn?: Array<'TERMINATED' | 'TIMED_OUT' | 'FAILED' | 'COMPLETED' | 'PAUSED'>;
}

export interface CancellationWatcher {
  watch(workflowInstanceId: string, abort: AbortController): () => void;
  stop(): void;
}
