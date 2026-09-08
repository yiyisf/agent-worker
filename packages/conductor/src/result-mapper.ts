/**
 * 运行状态 → Conductor 任务状态的映射，见 docs/architecture.md §6.2。
 *
 * 只有两种结局（extendLease 下任务从不中途交还，ADR-0022）：
 *   运行中   → IN_PROGRESS + callbackAfterSeconds（心跳）
 *   跑完了   → COMPLETED
 *   失败了   → 可重试走 FAILED（由 TaskDef.retryCount 决定），终局走 NonRetryableException
 *
 * 「Agent 判定做不到」不是失败：那是 COMPLETED + ok:false，交给工作流的 SWITCH 分支处理。
 */
import type { BlobStore, JsonObject, JsonValue } from '@ca/core';

/** 返回值形状对齐官方 ConductorWorker.execute 的 TaskResult / TaskInProgressResult */
export interface MappedTaskResult {
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  outputData?: Record<string, unknown>;
  callbackAfterSeconds?: number;
  reasonForIncompletion?: string;
}

export interface ResultMapperOptions {
  /** outputData 的体积预算，默认 256KB。比服务端 3072KB 外置阈值保守，留余量给工作流层聚合 */
  maxOutputBytes?: number;
  payloadStrategy?: 'externalize' | 'truncate' | 'fail';
  blobStore?: BlobStore;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** 终局错误：由调用方转成官方 NonRetryableException，Conductor 记 FAILED_WITH_TERMINAL_ERROR */
export class TerminalTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalTaskError';
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/**
 * 超预算的 result 外置到 BlobStore，outputData 只留 ref。
 * 直接返回原对象表示无需处理。
 */
export async function shrinkOutput(
  output: JsonObject,
  opts: ResultMapperOptions = {},
): Promise<JsonObject> {
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (byteLength(output) <= maxBytes) return output;

  const strategy = opts.payloadStrategy ?? 'externalize';
  const result = output.result;
  if (result === undefined) return output;

  if (strategy === 'fail') {
    throw new TerminalTaskError(
      `Agent 输出 ${byteLength(output)} 字节超过 outputData 预算 ${maxBytes}，payloadStrategy=fail`,
    );
  }
  if (strategy === 'externalize' && opts.blobStore) {
    const put = await opts.blobStore.put('result', JSON.stringify(result));
    return { ...output, result: { externalized: true, bytes: put.bytes } as JsonValue, resultRef: put.ref };
  }
  const text = JSON.stringify(result) ?? '';
  return {
    ...output,
    result: { truncated: true, head: text.slice(0, 2000), bytes: text.length } as JsonValue,
  };
}
