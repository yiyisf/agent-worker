/**
 * 运行态任务的输入/输出，见 docs/architecture.md §6.5 与 ADR-0020。
 *
 * 边界很硬：
 *   **进** —— `task.inputData` 原样就是 agent 的输入。没有保留键、没有命名空间、没有魔法。
 *   **出** —— `outputData` 由本模块生成，工作流用 `${ref.output.xxx}` 直接消费。
 *
 * 定义态的 inputKeys / outputKeys / inputTemplate 一概不参与：
 * 前两者在 3.21.21 全库没有任何读取点（纯 UI 文档），inputTemplate 由服务端在调度那一刻
 * 合并进 inputData，worker 看到的已经是合并后的结果。
 */
import type { JsonObject, JsonValue, ProgressReport, SerializedError } from '@ca/core';

/** 官方 Task 的最小形状 —— 只取 worker 自身执行真正需要的字段（§2.3） */
export interface ConductorTaskLike {
  taskId?: string;
  workflowInstanceId?: string;
  workflowType?: string;
  referenceTaskName?: string;
  correlationId?: string;
  /** >0 说明是重试，outputData 里带着上次 attempt 的结果 */
  retryCount?: number;
  /** 这个 taskId 被 poll 了几次。extendLease 模式下正常是 1，>1 说明发生过重新分配 */
  pollCount?: number;
  inputData?: Record<string, unknown>;
  /** 上一次 attempt 写入的 outputData —— 重试时由引擎原生携带（task.copy() 不重置它） */
  outputData?: Record<string, unknown>;
  /** 输入超过服务端阈值（默认 3072 KB）时，inputData 为空，真实内容在这个路径下 */
  externalInputPayloadStoragePath?: string;
}

/** 大输入的取回器。不提供则遇到外置输入直接判终局失败，绝不静默当成空输入 */
export type ExternalInputResolver = (path: string) => Promise<Record<string, unknown>>;

export class ExternalInputUnavailableError extends Error {
  constructor(readonly path: string) {
    super(
      `任务输入已被服务端外置到 ${path}，但未配置 externalInputResolver。` +
        `继续执行会让 agent 拿到空输入并产出错误结果，因此直接失败。` +
        `请提供 resolver（GET /tasks/externalstoragelocation 换取下载地址），或把大内容改成引用传递。`,
    );
    this.name = 'ExternalInputUnavailableError';
  }
}

/**
 * 取回本次执行的输入。
 *
 * 服务端在 `TaskModel.externalizeInput()` 里会把 inputData 清空只留路径，
 * 而官方 JS SDK 完全不处理这个字段 —— 不显式取回就会静默拿到 `{}`。
 */
export async function resolveInput(
  task: ConductorTaskLike,
  resolver?: ExternalInputResolver,
): Promise<JsonObject> {
  const path = task.externalInputPayloadStoragePath;
  if (path) {
    if (!resolver) throw new ExternalInputUnavailableError(path);
    return (await resolver(path)) as JsonObject;
  }
  return (task.inputData ?? {}) as JsonObject;
}

/** 上一次 attempt / 上一次 callback 的输出，供 agent 做业务判断（不是恢复机制） */
export function previousAttemptOf(task: ConductorTaskLike): JsonValue | undefined {
  const out = task.outputData;
  if (!out || Object.keys(out).length === 0) return undefined;
  return out as JsonValue;
}

/**
 * outputData 只在**任务结束时**写一次。
 *
 * extendLease 心跳走的是 `updateTask({ extendLease: true })`，服务端在
 * `if (taskResult.isExtendLease()) { extendLease(taskResult); return null; }` 就 return 了，
 * **碰不到 outputData**。运行途中的进展因此只能走 Task Log 通道（§10.4）。
 */
function withProgress(base: JsonObject, progress?: ProgressReport): JsonObject {
  if (!progress) return base;
  return {
    ...base,
    progress: progress as unknown as JsonValue,
    usage: progress.usage as unknown as JsonValue,
  };
}

export function doneOutput(args: {
  taskId: string;
  result: JsonValue;
  progress?: ProgressReport | undefined;
}): JsonObject {
  return withProgress({ ok: true, status: 'done', taskId: args.taskId, result: args.result }, args.progress);
}

export function failedOutput(args: {
  taskId: string;
  error: SerializedError;
  progress?: ProgressReport | undefined;
}): JsonObject {
  return withProgress(
    {
      ok: false,
      status: 'failed',
      taskId: args.taskId,
      error: { name: args.error.name, message: args.error.message, retryable: args.error.retryable },
    },
    args.progress,
  );
}
