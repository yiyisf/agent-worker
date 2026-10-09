/**
 * 错误分级与 Conductor 终态映射，见 docs/architecture.md §6.2 与 ADR-0020。
 * 移植自 Claude Projects 版 ca-worker（errors/status.ts），新增 FENCED。
 *
 * retryable=false 的错误上报为 FAILED_WITH_TERMINAL_ERROR —— 实测（§2.3 #2）该状态不消耗重试；
 * 经官方 SDK 上报时等价于抛 NonRetryableException。
 */
import type { AgentError, AgentErrorCode } from './envelope/types.js';

/** 各错误码本地重试耗尽后的默认可重试性 */
export const DEFAULT_RETRYABLE: Readonly<Record<AgentErrorCode, boolean>> = {
  MODEL_RATE_LIMIT: true,
  MODEL_UNAVAILABLE: true,
  TOOL_FAILED: true,
  TIMEOUT: true,
  INVALID_OUTPUT: true,
  INTERNAL: true,
  INVALID_INPUT: false,
  BUDGET_EXCEEDED: false,
  POLICY_DENIED: false,
  CANCELLED: false,
  /** 已被更新的 fenceToken 取代：执行权在别的 worker 手里，本次重试无意义（ADR-0022） */
  FENCED: false,
};

export type ConductorFinalStatus = 'COMPLETED' | 'FAILED' | 'FAILED_WITH_TERMINAL_ERROR';

export function agentError(code: AgentErrorCode, message: string, details?: unknown, retryable?: boolean): AgentError {
  return { code, message, retryable: retryable ?? DEFAULT_RETRYABLE[code], ...(details === undefined ? {} : { details }) };
}

export function toConductorStatus(error: AgentError | undefined): ConductorFinalStatus {
  if (!error) return 'COMPLETED';
  return error.retryable ? 'FAILED' : 'FAILED_WITH_TERMINAL_ERROR';
}

/** 写入 TaskResult.reasonForIncompletion，截断以免撑大任务记录 */
export function reasonForIncompletion(error: AgentError, maxChars = 500): string {
  const text = `${error.code}: ${error.message}`;
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
