/** core 的错误类型。可重试与否直接决定 Conductor 的状态映射（§6.2）。 */

export class CaError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BudgetExceededError extends CaError {
  constructor(readonly metric: 'tokens' | 'cost' | 'time' | 'toolCalls') {
    super(`budget exceeded: ${metric}`, false);
  }
}

export class GuardrailBlockedError extends CaError {
  constructor(
    readonly rule: string,
    terminal = true,
  ) {
    super(`blocked by guardrail: ${rule}`, !terminal);
  }
}

/**
 * 单次模型调用或工具执行超时。可重试 —— 慢一次不代表这次运行没救。
 *
 * ⚠️ 字段叫 callName 而不是 name：`readonly name` 会覆盖 Error.name，
 * 让错误在序列化后失去类型标识（被这条的单测抓到过）。
 */
export class CallTimeoutError extends CaError {
  constructor(
    readonly kind: 'model' | 'tool',
    readonly callName: string,
    readonly timeoutMs: number,
  ) {
    super(`${kind} "${callName}" 超过 ${timeoutMs}ms 未返回`, true);
  }
}

/** 整次运行超过 limits.wallClockMs。终局 —— 再跑一次多半还是超 */
export class RunTimeoutError extends CaError {
  constructor(readonly wallClockMs: number) {
    super(`agent 运行超过 wallClockMs=${wallClockMs}ms`, false);
  }
}

/** 能力—配置一致性校验失败：启动时拒绝，不留到运行期（§4.4） */
export class CapabilityError extends CaError {
  constructor(message: string) {
    super(message, false);
  }
}

/** 可跨进程传输的错误快照 */
export interface SerializedError {
  name: string;
  message: string;
  retryable: boolean;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof CaError) {
    return { name: err.name, message: err.message, retryable: err.retryable };
  }
  const e = err as Error;
  return { name: e?.name ?? 'Error', message: e?.message ?? String(err), retryable: true };
}
