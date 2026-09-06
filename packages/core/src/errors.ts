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
 * 模糊重放：journal 里只有 tool.intent 没有结果 —— 工具执行到一半进程没了，
 * 不知道副作用有没有生效（ADR-0005）。默认终局失败，把决策交给工作流的补偿分支。
 */
export class AmbiguousReplayError extends CaError {
  constructor(
    readonly toolName: string,
    readonly stepId: string,
  ) {
    super(
      `tool "${toolName}" 上次执行结果未知（只有 intent 没有 result），` +
        `按 onAmbiguousReplay=fail 终止；stepId=${stepId}`,
      false,
    );
  }
}

/** 抢占失败或 fence 落后：立即放弃，不回写 Conductor（§5.3） */
export class FencedOutError extends CaError {
  constructor(
    readonly runKey: string,
    readonly ownFence: number,
    readonly currentFence: number,
  ) {
    super(`run ${runKey} fenced out: own=${ownFence} current=${currentFence}`, true);
  }
}

/** 能力—配置一致性校验失败：启动时拒绝，不留到运行期（§4.4） */
export class CapabilityError extends CaError {
  constructor(message: string) {
    super(message, false);
  }
}
