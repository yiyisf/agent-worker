/**
 * SliceOutcome → Conductor 任务状态的映射，见 docs/architecture.md §6.2、§6.3。
 *
 * 映射要点：
 * - 「Agent 判定做不到」是 COMPLETED + ok:false，交给工作流 SWITCH 分支，而非 FAILED
 * - 瞬时错误 → FAILED（走 TaskDef 重试）；终局错误 → 官方 NonRetryableException
 * - EngineTurn 的 done / continue / suspended 三态直接对应 COMPLETED 与 IN_PROGRESS 的两种交还
 * - transcript 与超限 payload 外置到 BlobStore，outputData 只留 ref
 */
import type { BlobStore, JsonValue, SliceOutcome } from '@ca/core';

/** 返回值形状对齐官方 ConductorWorker.execute 的 TaskResult / TaskInProgressResult */
export interface MappedTaskResult {
  status: 'COMPLETED' | 'IN_PROGRESS' | 'FAILED';
  /**
   * 分片交还时除了业务字段，还带 progress（ADR-0018 的权威通道）与 specHash：
   *   { ok?, result?, progress?, specHash, usage, slices, transcriptRef }
   * 工作流可读 ${agent_ref.output.progress.step} 做分支或告警。
   */
  outputData?: Record<string, unknown>;
  callbackAfterSeconds?: number;
  reasonForIncompletion?: string;
}

export interface ResultMapperOptions {
  /** outputData 的体积预算，默认 256KB（§6.3） */
  maxOutputBytes?: number;
  payloadStrategy?: 'externalize' | 'truncate' | 'fail';
  blobStore?: BlobStore;
  /** effective spec 的哈希，只放 hash 不放全文 —— 全文进 journal，否则撑爆 payload 预算（§7.2） */
  specHash?: string;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** 终局错误：由调用方转成官方 NonRetryableException，Conductor 会记 FAILED_WITH_TERMINAL_ERROR */
export class TerminalTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalTaskError';
  }
}

export interface ToTaskResultArgs {
  outcome: SliceOutcome;
  /** 由 checkHandbackBudget 夹过的交还秒数 */
  callbackAfterSeconds?: number;
  progress?: JsonValue;
}

export async function toTaskResult(
  args: ToTaskResultArgs,
  opts: ResultMapperOptions = {},
): Promise<MappedTaskResult> {
  const { outcome } = args;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const strategy = opts.payloadStrategy ?? 'externalize';

  const common: Record<string, unknown> = {
    usage: {
      inputTokens: outcome.budget.inputTokens,
      outputTokens: outcome.budget.outputTokens,
      costUsd: outcome.budget.costUsd,
    },
    slices: outcome.sliceIndex + 1,
    ...(opts.specHash ? { specHash: opts.specHash } : {}),
    ...(args.progress !== undefined ? { progress: args.progress } : {}),
  };

  if (outcome.kind === 'continue' || outcome.kind === 'suspended') {
    return {
      status: 'IN_PROGRESS',
      callbackAfterSeconds: args.callbackAfterSeconds ?? 1,
      outputData: {
        ...common,
        state: outcome.kind,
        ...(outcome.kind === 'suspended'
          ? { awaiting: outcome.awaiting, resumeToken: outcome.resumeToken }
          : {}),
      },
    };
  }

  if (outcome.kind === 'done') {
    let result: unknown = outcome.output;
    let transcriptRef: string | undefined;

    if (byteLength(result) > maxBytes) {
      if (strategy === 'fail') {
        throw new TerminalTaskError(
          `Agent 输出 ${byteLength(result)} 字节超过 outputData 预算 ${maxBytes}，payloadStrategy=fail`,
        );
      }
      if (strategy === 'externalize' && opts.blobStore) {
        const put = await opts.blobStore.put('result', JSON.stringify(result));
        transcriptRef = put.ref;
        result = { externalized: true, bytes: put.bytes };
      } else {
        const text = JSON.stringify(result) ?? '';
        result = { truncated: true, head: text.slice(0, 2000), bytes: text.length };
      }
    }

    return {
      status: 'COMPLETED',
      outputData: {
        ok: true,
        result,
        ...(transcriptRef ? { transcriptRef } : {}),
        ...common,
      },
    };
  }

  // failed：可重试的交给 TaskDef 重试策略，终局的由调用方转成 NonRetryableException
  if (!outcome.error.retryable) {
    throw new TerminalTaskError(outcome.error.message);
  }
  return {
    status: 'FAILED',
    reasonForIncompletion: outcome.error.message.slice(0, 500),
    outputData: { ok: false, error: outcome.error.name, ...common },
  };
}
