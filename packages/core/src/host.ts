/**
 * 后台运行宿主 —— 异步化的执行面，见 docs/architecture.md §5.2 与 ADR-0019/0021。
 *
 * 职责边界很窄，只有四件事：
 *   1. 在后台发起一次完整的 agent 运行（不阻塞调用方）
 *   2. 周期性刷新注册表心跳 —— 这是「运行还活着」的唯一证据
 *   3. 心跳被拒（所有权已被接管）或运行超时 / 工作流被终止时，中止本次运行
 *   4. 运行结束时写注册表，并立刻回调 onSettled，让桥接层直接把任务推向终态
 *
 * 宿主是**进程内**的：进程没了，运行就没了。这不是遗漏，是选择 ——
 * 失联由心跳暴露，处置由 spec.conductor.onOrphan 决定（默认整次重跑）。
 */
import type { AgentSpec, JsonValue } from './spec.js';
import type { BuiltAgent } from './engine.js';
import type { ConductorSource, Logger, RunContext } from './context.js';
import type { AgentEvent, EventSink } from './events.js';
import type { ProgressOptions, ProgressReport } from './progress.js';
import type { RunOutcomeRecord, RunRegistry } from './registry.js';
import { DEFAULT_WALL_CLOCK_MS } from './spec.js';
import { createThrottledReporter } from './progress.js';
import { RunTimeoutError, serializeError } from './errors.js';
import { runAgent } from './runner.js';

export const DEFAULT_HEARTBEAT_MS = 15_000;

export interface AgentRunHostDeps {
  registry: RunRegistry;
  workerId: string;
  logger: Logger;
  eventSinks?: readonly EventSink[];
  /** 心跳间隔，默认 15_000。必须显著小于 spec.conductor.orphanAfterMs */
  heartbeatMs?: number;
}

export interface StartRunArgs {
  /** = Conductor 的 taskId（ADR-0020） */
  runId: string;
  spec: AgentSpec;
  agent: BuiltAgent;
  input: JsonValue;
  previousAttempt?: JsonValue;
  attempt: number;
  source?: ConductorSource;
  takeover: boolean;
  progressOptions?: ProgressOptions;
  onProgress?: (r: ProgressReport) => void;
  /** 运行结束时立刻回调 —— 桥接层据此直接 updateTask，不等下一次 callback */
  onSettled?: (outcome: RunOutcomeRecord) => void | Promise<void>;
  /** 每次心跳时调用；返回 true 表示应中止（如工作流已被终止） */
  shouldAbort?: () => Promise<boolean>;
  /** 每次心跳时调用一次，供桥接层顺带把攒下的 task log 推出去 */
  onHeartbeat?: () => void | Promise<void>;
}

export class AgentRunHost {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: AgentRunHostDeps) {}

  /** 当前进程正在跑的运行数 */
  get size(): number {
    return this.inFlight.size;
  }

  /**
   * 发起一次后台运行。**立即返回** —— 调用方随即交还任务给编排引擎。
   * 调用前必须已经通过 registry.tryStart 取得所有权。
   */
  start(args: StartRunArgs): void {
    if (this.inFlight.has(args.runId)) return;
    const task = this.execute(args).finally(() => this.inFlight.delete(args.runId));
    this.inFlight.set(args.runId, task);
    // 后台运行的失败已在 execute 内部收敛成注册表里的 failed 记录，这里只兜底日志
    task.catch((err) => this.deps.logger.error(`[${args.spec.name}] 运行宿主异常：${String(err)}`));
  }

  /** 优雅停机：等待所有在跑的运行结束 */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()]);
  }

  private emit(e: AgentEvent): void {
    for (const sink of this.deps.eventSinks ?? []) void sink.handle(e);
  }

  private async execute(args: StartRunArgs): Promise<void> {
    const { registry, workerId, logger } = this.deps;
    const heartbeatMs = this.deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const wallClockMs = args.spec.limits?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    const startedAt = Date.now();

    const controller = new AbortController();
    const progress = createThrottledReporter(
      (r) => args.onProgress?.(r),
      args.progressOptions ?? {},
    );

    const wallClockTimer = setTimeout(() => {
      controller.abort(new RunTimeoutError(wallClockMs));
    }, wallClockMs);

    // 心跳：既刷新「我还活着」，也顺带检查所有权是否已被接管、工作流是否已终止
    const beat = setInterval(() => {
      void (async () => {
        try {
          const alive = await registry.heartbeat(args.runId, workerId, progress.snapshot());
          if (!alive) {
            logger.warn(`[${args.spec.name}] ${args.runId} 所有权已易主，中止本地运行`);
            controller.abort(new Error('run ownership taken over'));
            return;
          }
          if (args.shouldAbort && (await args.shouldAbort())) {
            logger.info(`[${args.spec.name}] ${args.runId} 所属工作流已终止，中止运行`);
            controller.abort(new Error('workflow terminated'));
            return;
          }
          await args.onHeartbeat?.();
        } catch (err) {
          logger.warn(`[${args.spec.name}] ${args.runId} 心跳失败：${String(err)}`);
        }
      })();
    }, heartbeatMs);
    // 心跳定时器不应该拖住进程退出
    if (typeof beat.unref === 'function') beat.unref();
    if (typeof wallClockTimer.unref === 'function') wallClockTimer.unref();

    const budgetView = {
      usedInputTokens: 0,
      usedOutputTokens: 0,
      usedCostUsd: 0,
      elapsedMs: 0,
      remaining: () => Infinity,
    };

    const ctx: RunContext = {
      runId: args.runId,
      attempt: args.attempt,
      startedAt,
      deadline: startedAt + wallClockMs,
      signal: controller.signal,
      logger,
      budget: budgetView,
      secrets: { get: async () => undefined },
      emit: (e) => this.emit(e),
      ...(args.source ? { source: args.source } : {}),
    };

    this.emit({
      type: 'run.started',
      runId: args.runId,
      spec: args.spec.name,
      engine: args.spec.engine,
      takeover: args.takeover,
    });

    let outcome: RunOutcomeRecord;
    try {
      const result = await runAgent({
        spec: args.spec,
        agent: args.agent,
        input: args.input,
        ...(args.previousAttempt !== undefined ? { previousAttempt: args.previousAttempt } : {}),
        ctx,
        onProgress: (r) => progress.report(r),
      });
      outcome =
        result.kind === 'done'
          ? { status: 'done', result: result.output, ...(progress.snapshot() ? { progress: progress.snapshot()! } : {}) }
          : { status: 'failed', error: result.error, ...(progress.snapshot() ? { progress: progress.snapshot()! } : {}) };
    } catch (err) {
      outcome = { status: 'failed', error: serializeError(err) };
    } finally {
      clearInterval(beat);
      clearTimeout(wallClockTimer);
      progress.flush();
    }

    this.emit({
      type: 'run.finished',
      runId: args.runId,
      outcome: outcome.status === 'done' ? 'ok' : 'error',
      durationMs: Date.now() - startedAt,
    });

    // 所有权已易主时 finish 返回 false —— 不覆盖新 owner 的结果，也不回执
    const owned = await registry.finish(args.runId, workerId, outcome);
    if (!owned) {
      logger.warn(`[${args.spec.name}] ${args.runId} 结果被丢弃：所有权已易主`);
      return;
    }

    // 直接把任务推向终态，不等下一次 callback（§5.2）
    try {
      await args.onSettled?.(outcome);
    } catch (err) {
      // 回执失败不是灾难：结果已在注册表里，下一次 callback 会把它取走
      logger.warn(
        `[${args.spec.name}] ${args.runId} 主动回执失败，改由下次 callback 兜底：${String(err)}`,
      );
    }
  }
}
