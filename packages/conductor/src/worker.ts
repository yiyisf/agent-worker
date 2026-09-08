/**
 * 用户入口：把 AgentSpec 挂到 Conductor 上。见 docs/architecture.md §6.1 与 ADR-0022。
 *
 * 本层是**薄桥接**（ADR-0006）：poll 循环、并发、指标、优雅停机、**以及租约心跳**
 * 全部来自官方 `@io-orkes/conductor-javascript`。
 *
 * execute() 就是**把 agent 从头跑到完**，跑多久都行：
 *
 *   poll → 任务从队列里被 ack 删除，只属于这个 worker
 *        → execute() 里 runAgent()，官方 LeaseTracker 同时按
 *          responseTimeoutSeconds × 0.8 的间隔自动发 extendLease 心跳
 *        → 返回终态，任务结束
 *
 *   worker 崩了 → 没人心跳 → responseTimeout 后判 TIMED_OUT
 *               → 消耗一次 retryCount → 新 taskId 重新分配给别的 worker
 *
 * 所以「一次执行始终在同一个 worker」是**引擎保证的**，我们不需要运行状态存储、
 * 不需要所有权、不需要心跳实现、不需要 Redis。
 */
import {
  DEFAULT_WALL_CLOCK_MS,
  RunTimeoutError,
  assertCapabilities,
  runAgent,
} from '@ca/core';
import type {
  AgentEngine,
  AgentEvent,
  AgentSpec,
  BlobStore,
  BuiltAgent,
  ConductorSource,
  EventSink,
  JsonValue,
  Logger,
  ProgressReport,
  RunContext,
  RunOutcome,
} from '@ca/core';
import { CaError } from '@ca/core';
import {
  createProgressReporter,
  priorAttemptLine,
  type ConductorProgressOptions,
  type TaskLogSink,
} from './progress.js';
import {
  previousAttemptOf,
  resolveInput,
  doneOutput,
  failedOutput,
  type ConductorTaskLike,
  type ExternalInputResolver,
} from './task-io.js';
import { deriveTaskDef, responseTimeoutOf, taskTypeOf } from './taskdef.js';
import { heartbeatIntervalMs } from './lease.js';
import {
  TerminalTaskError,
  shrinkOutput,
  type MappedTaskResult,
  type ResultMapperOptions,
} from './result-mapper.js';

export type { ConductorTaskLike, ExternalInputResolver } from './task-io.js';

/** 官方 ConductorWorker 的形状（v4.0.0） */
export interface CompiledWorker {
  taskDefName: string;
  execute: (task: ConductorTaskLike) => Promise<MappedTaskResult>;
  domain?: string;
  concurrency?: number;
  pollInterval?: number;
  /** 官方 LeaseTracker 的开关 —— 本 SDK 恒为 true，它是「同一 worker」的保证来源 */
  leaseExtendEnabled: boolean;
}

export interface CompileDeps {
  engines: readonly AgentEngine[];
  blobStore?: BlobStore;
  eventSinks?: readonly EventSink[];
  logger?: Logger;
  /** 大输入取回器；不提供则遇到外置输入直接判终局失败（绝不静默空输入） */
  externalInputResolver?: ExternalInputResolver;
  /**
   * 进展的**运行中**通道（§10.4）。extendLease 模式下 outputData 只在结束时写一次，
   * 所以这是运行途中唯一能看见进度的地方 —— 强烈建议接上。
   */
  taskLogSink?: (task: ConductorTaskLike) => TaskLogSink | undefined;
  progress?: ConductorProgressOptions;
  onProgress?: (task: ConductorTaskLike, report: ProgressReport) => void;
  /** 取消检测：返回 true 表示该工作流已终止，应中止运行（§6.4） */
  isWorkflowCancelled?: (workflowInstanceId: string) => Promise<boolean>;
  resultMapper?: ResultMapperOptions;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const DEFAULT_TICK_MS = 15_000;

/**
 * 把一个 AgentSpec 编译成官方 SDK 认识的 worker。
 * 供已有 worker 工程渐进接入：拿到返回值直接塞进自己的 TaskManager 即可。
 */
export function compileAgentWorker(spec: AgentSpec, deps: CompileDeps): CompiledWorker {
  const logger = deps.logger ?? noopLogger;
  const engine = deps.engines.find((e) => e.id === spec.engine);
  if (!engine) {
    throw new Error(
      `AgentSpec "${spec.name}" 声明的引擎 "${spec.engine}" 未注册。已注册：${deps.engines.map((e) => e.id).join(', ') || '（无）'}`,
    );
  }

  // 能力—配置一致性校验：不满足就在**启动时**拒绝，不留到运行期（§4.4）
  const check = assertCapabilities(spec, engine.capabilities, {
    ...(engine.builtinTools ? { builtinTools: engine.builtinTools } : {}),
  });
  for (const w of check.warnings) logger.warn(`[${spec.name}] ${w}`);

  // 副作用是校验 responseTimeoutSeconds 够不够官方心跳用；取值错了在这里就拒绝
  const responseTimeoutSeconds = responseTimeoutOf(spec);
  deriveTaskDef(spec);
  logger.info(
    `[${spec.name}] extendLease 心跳：每 ${Math.round(heartbeatIntervalMs(responseTimeoutSeconds) / 1000)}s 一次` +
      `（responseTimeoutSeconds=${responseTimeoutSeconds}），由官方 LeaseTracker 托管`,
  );

  const wallClockMs = spec.limits?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const tickMs = Math.max(1_000, deps.progress?.intervalMs ?? DEFAULT_TICK_MS);
  const emit = (e: AgentEvent): void => {
    for (const sink of deps.eventSinks ?? []) void sink.handle(e);
  };

  let built: BuiltAgent | undefined;

  const toResult = async (
    taskId: string,
    outcome: RunOutcome,
    progress: ProgressReport | undefined,
  ): Promise<MappedTaskResult> => {
    if (outcome.kind === 'done') {
      const output = await shrinkOutput(
        doneOutput({ taskId, result: outcome.output, progress }),
        deps.resultMapper ?? {},
      );
      return { status: 'COMPLETED', outputData: output };
    }
    const { error } = outcome;
    if (!error.retryable) throw new TerminalTaskError(error.message);
    return {
      status: 'FAILED',
      outputData: failedOutput({ taskId, error, progress }),
      reasonForIncompletion: error.message.slice(0, 500),
    };
  };

  return {
    taskDefName: taskTypeOf(spec),
    ...(spec.conductor?.domain ? { domain: spec.conductor.domain } : {}),
    // ⚠️ 这一位是整个设计的支点：关掉它，长任务会在 responseTimeout 后被判死并重新分配
    leaseExtendEnabled: true,

    async execute(task: ConductorTaskLike): Promise<MappedTaskResult> {
      const taskId = task.taskId ?? '';
      const startedAt = Date.now();

      const input = await resolveInput(task, deps.externalInputResolver);
      const previousAttempt = previousAttemptOf(task);
      if (!built) built = await engine.build(spec, { logger });

      // 取消与超时统一走这一个 signal
      const controller = new AbortController();
      const wallClockTimer = setTimeout(
        () => controller.abort(new RunTimeoutError(wallClockMs)),
        wallClockMs,
      );
      if (typeof wallClockTimer.unref === 'function') wallClockTimer.unref();

      const reporter = createProgressReporter(deps.taskLogSink?.(task), {
        ...(deps.progress ?? {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
      // 重试换了新 taskId，task log 会断档；把上次 attempt 的落点接上（原生携带的 outputData）
      const prior = task.outputData?.progress as ProgressReport | undefined;
      if ((task.retryCount ?? 0) > 0 && prior?.step) {
        reporter.report({ ...prior, phase: priorAttemptLine(prior) });
      }

      // 运行期唯一的周期任务：把攒下的 task log 推出去 + 查工作流是否已被终止。
      // 心跳不在这里 —— 那是官方 LeaseTracker 的事。
      const tick = setInterval(() => {
        void (async () => {
          try {
            await reporter.drain();
            if (deps.isWorkflowCancelled && task.workflowInstanceId) {
              if (await deps.isWorkflowCancelled(task.workflowInstanceId)) {
                logger.info(`[${spec.name}] ${taskId} 所属工作流已终止，中止运行`);
                controller.abort(new CaError('所属工作流已终止，放弃本次运行', false));
              }
            }
          } catch (err) {
            logger.warn(`[${spec.name}] ${taskId} 运行期巡检失败：${String(err)}`);
          }
        })();
      }, tickMs);
      if (typeof tick.unref === 'function') tick.unref();

      const source: ConductorSource | undefined = task.workflowInstanceId
        ? {
            workflowInstanceId: task.workflowInstanceId,
            workflowName: task.workflowType ?? '',
            taskId,
            taskReferenceName: task.referenceTaskName ?? '',
            ...(task.correlationId ? { correlationId: task.correlationId } : {}),
            retryCount: task.retryCount ?? 0,
          }
        : undefined;

      const ctx: RunContext = {
        runId: taskId,
        attempt: task.retryCount ?? 0,
        startedAt,
        deadline: startedAt + wallClockMs,
        signal: controller.signal,
        logger,
        budget: {
          usedInputTokens: 0,
          usedOutputTokens: 0,
          usedCostUsd: 0,
          elapsedMs: 0,
          remaining: () => Infinity,
        },
        secrets: { get: async () => undefined },
        emit,
        ...(source ? { source } : {}),
      };

      emit({ type: 'run.started', runId: taskId, spec: spec.name, engine: spec.engine });

      try {
        const outcome = await runAgent({
          spec,
          agent: built,
          input: input as JsonValue,
          ...(previousAttempt !== undefined ? { previousAttempt } : {}),
          ctx,
          onProgress: (r) => {
            reporter.report(r);
            deps.onProgress?.(task, r);
          },
        });

        emit({
          type: 'run.finished',
          runId: taskId,
          outcome: outcome.kind === 'done' ? 'ok' : 'error',
          durationMs: Date.now() - startedAt,
        });

        return await toResult(taskId, outcome, reporter.snapshot());
      } finally {
        clearInterval(tick);
        clearTimeout(wallClockTimer);
        reporter.flush();
        await reporter.drain();
      }
    },
  };
}

export interface AgentWorkerOptions extends CompileDeps {
  /** 纯数据的 Agent 描述；SpecLoader 会做三层合并与校验（ADR-0013） */
  specs: readonly AgentSpec[];
}

export interface AgentWorker {
  workers: CompiledWorker[];
  taskDefs: ReturnType<typeof deriveTaskDef>[];
}

/**
 * 把一组 AgentSpec 编译成官方 worker 列表 + 对应 TaskDef。
 *
 * 刻意不在这里 new TaskManager：poll 循环、并发、优雅停机是官方 SDK 的职责。
 *
 *   const { workers, taskDefs } = createAgentWorker({ specs, engines });
 *   for (const def of taskDefs) await metadataClient.registerTask(def);
 *   new TaskManager(client, workers, { options: { concurrency: 4 } }).startPolling();
 *
 * ⚠️ **concurrency 的含义变了**：一个长跑 agent 会占住一个并发槽的**全程**。
 * 按「同时最多跑几个 agent」来配，而不是「每秒处理几个任务」。
 */
export function createAgentWorker(options: AgentWorkerOptions): AgentWorker {
  const workers = options.specs.map((spec) => compileAgentWorker(spec, options));
  const taskDefs = options.specs.map((spec) => deriveTaskDef(spec));
  return { workers, taskDefs };
}
