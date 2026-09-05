/**
 * Agent 结果 → 官方 SDK TaskResult 的映射，见 docs/architecture.md §6.2 与 §6.3。占位。
 *
 * 映射要点：
 * - 「Agent 判定做不到」是 COMPLETED + ok:false，交给工作流 SWITCH 分支，而非 FAILED
 * - 瞬时错误 → FAILED（走 TaskDef 重试）；终局错误 → 官方 NonRetryableException
 * - transcript 始终外置到 BlobStore，output 只留 ref
 * - Task Log 通过官方 getTaskContext()?.addLog() 写，不自研日志通道
 */
import type { BlobStore, EngineTurn, JsonValue } from '@ca/core';
import type { LeaseOutcome } from './lease.js';

export interface ResultMapperOptions {
  maxOutputBytes: number;
  payloadStrategy: 'externalize' | 'truncate' | 'fail';
  blobStore?: BlobStore;
}

/** 返回值形状对齐官方 ConductorWorker.execute 的 TaskResult */
export interface MappedTaskResult {
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  outputData?: Record<string, unknown>;
  callbackAfterSeconds?: number;
  reasonForIncompletion?: string;
}

export interface ResultMapper {
  /** EngineTurn 的 done / continue / suspended 三态直接对应 COMPLETED 与 IN_PROGRESS 的两种交还 */
  toTaskResult(turn: EngineTurn<JsonValue>, outcome: LeaseOutcome): Promise<MappedTaskResult>;
  toFailure(err: unknown): Promise<MappedTaskResult>;
}

/** 错误分类：决定 FAILED 还是抛官方 NonRetryableException */
export interface ErrorClassifier {
  isRetryable(err: unknown): boolean;
}
