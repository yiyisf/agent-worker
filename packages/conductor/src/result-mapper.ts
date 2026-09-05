/**
 * Agent 结果 → Conductor TaskResult 的映射，见 docs/architecture.md §6.3 与 §6.4。
 * 占位：仅声明契约。
 *
 * 映射要点：
 * - 「Agent 判定做不到」是 COMPLETED + ok:false，交给工作流 SWITCH 分支，而非 FAILED
 * - 瞬时错误 → FAILED（走 TaskDef 重试）；终局错误 → FAILED_WITH_TERMINAL_ERROR
 * - transcript 始终外置到 BlobStore，output 只留 ref
 */
import type { AgentResult, BlobStore } from '@ca/core';
import type { ConductorTask, TaskResult } from './client.js';

export interface ResultMapperOptions {
  maxOutputBytes: number;
  payloadStrategy: 'externalize' | 'truncate' | 'fail';
  blobStore?: BlobStore;
}

export interface ResultMapper {
  toTaskResult(task: ConductorTask, result: AgentResult): Promise<TaskResult>;
  toFailure(task: ConductorTask, err: unknown): Promise<TaskResult>;
  toYield(task: ConductorTask, callbackAfterSeconds: number, reason: string): TaskResult;
}

/** 错误分类：决定 FAILED 还是 FAILED_WITH_TERMINAL_ERROR */
export interface ErrorClassifier {
  isRetryable(err: unknown): boolean;
}
