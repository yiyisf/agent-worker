/**
 * 用户入口：把 AgentSpec 挂到 Conductor 上。见 docs/architecture.md §6.1 与 ADR-0019/0020/0021。
 *
 * 本层是**薄桥接**（ADR-0006）：poll 循环、并发、指标、优雅停机全部交给官方
 * `@io-orkes/conductor-javascript` 的 TaskManager。
 *
 * execute() 的全部职责是**在毫秒内回答一个问题**：这个 taskId 的运行现在怎么样了？
 * agent 本身在后台跑，与编排任务的执行窗口彻底解耦（ADR-0019）。
 *
 *   没有       → 取得所有权，后台发起运行，回执 IN_PROGRESS
 *   正在跑     → 回执 IN_PROGRESS（带进展）
 *   跑完了     → 回执 COMPLETED / FAILED
 *   宿主失联   → 按 onOrphan 接管重跑或判失败
 *
 * 运行结束时后台会**直接** updateTask 把任务推向终态，不必等下一次 callback。
 */
import {
  AgentRunHost,
  DEFAULT_CALLBACK_AFTER_SECONDS,
  DEFAULT_ORPHAN_AFTER_MS,
  MemoryRunRegistry,
  assertCapabilities,
} from '@ca/core';
import type {
  AgentEngine,
  AgentSpec,
  BlobStore,
  BuiltAgent,
  ConductorSource,
  EventSink,
  JsonValue,
  Logger,
  ProgressReport,
  RunOutcomeRecord,
  RunRecord,
  RunRegistry,
} from '@ca/core';
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
  runningOutput,
  type ConductorTaskLike,
  type ExternalInputResolver,
} from './task-io.js';
import { deriveTaskDef, taskTypeOf } from './taskdef.js';
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
}

/**
 * 主动回执：后台运行结束时直接把任务推向终态。
 * 已核实 `updateTask` 对调用方没有「必须是 poll 到它的 worker」的校验，
 * 且 SCHEDULED（等待 callback 中）不是终态，所以任何持有 taskId 的进程都能推。
 */
export type UpdateTaskFn = (result: {
  taskId: string;
  workflowInstanceId: string;
  status: 'COMPLETED' | 'FAILED';
  outputData: Record<string, unknown>;
  reasonForIncompletion?: string;
}) => Promise<void>;

export interface CompileDeps {
  engines: readonly AgentEngine[];
  /**
   * 运行注册表。默认单进程内存实现 —— **多实例部署必须换成共享实现**
   * （@ca/memory 的 RedisRunRegistry）：Conductor 不保证 callback 回到同一个 worker。
   */
  registry?: RunRegistry;
  /** 复用同一个后台宿主（多个 spec 共享时传入），不传则每个 worker 自建 */
  host?: AgentRunHost;
  blobStore?: BlobStore;
  eventSinks?: readonly EventSink[];
  logger?: Logger;
  workerId?: string;
  /** 大输入取回器；不提供则遇到外置输入直接判终局失败（绝不静默空输入） */
  externalInputResolver?: ExternalInputResolver;
  /** 不提供则退化为「等下一次 callback 才回执」，正确但慢一个 callback 周期 */
  updateTask?: UpdateTaskFn;
  /** 进展的尽力而为通道（§10.4）；不提供则只写权威通道 outputData.progress */
  taskLogSink?: (task: ConductorTaskLike) => TaskLogSink | undefined;
  progress?: ConductorProgressOptions;
  onProgress?: (task: ConductorTaskLike, report: ProgressReport) => void;
  /** 取消检测：返回 true 表示该工作流已终止，应中止运行（§6.4） */
  isWorkflowCancelled?: (workflowInstanceId: string) => Promise<boolean>;
  resultMapper?: ResultMapperOptions;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function progressOf(record: RunRecord | RunOutcomeRecord): ProgressReport | undefined {
  return record.progress;
}

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

  const workerId = deps.workerId ?? `ca-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const registry = deps.registry ?? new MemoryRunRegistry();
  const host =
    deps.host ??
    new AgentRunHost({
      registry,
      workerId,
      logger,
      ...(deps.eventSinks ? { eventSinks: deps.eventSinks } : {}),
    });

  const callbackAfterSeconds = spec.conductor?.callbackAfterSeconds ?? DEFAULT_CALLBACK_AFTER_SECONDS;
  const orphanAfterMs = spec.conductor?.orphanAfterMs ?? DEFAULT_ORPHAN_AFTER_MS;
  const onOrphan = spec.conductor?.onOrphan ?? 'restart';

  let built: BuiltAgent | undefined;

  const finalize = async (
    runId: string,
    record: RunRecord | RunOutcomeRecord,
  ): Promise<MappedTaskResult> => {
    const progress = progressOf(record);
    if (record.status === 'done') {
      const output = await shrinkOutput(
        doneOutput({ runId, result: record.result ?? null, progress }),
        deps.resultMapper ?? {},
      );
      return { status: 'COMPLETED', outputData: output };
    }
    const error = record.error ?? { name: 'UnknownError', message: '运行失败但未记录原因', retryable: true };
    const output = failedOutput({ runId, error, progress });
    if (!error.retryable) throw new TerminalTaskError(error.message);
    return {
      status: 'FAILED',
      outputData: output,
      reasonForIncompletion: error.message.slice(0, 500),
    };
  };

  return {
    taskDefName: taskTypeOf(spec),
    ...(spec.conductor?.domain ? { domain: spec.conductor.domain } : {}),

    async execute(task: ConductorTaskLike): Promise<MappedTaskResult> {
      // runId = taskId：同一次执行的多次 callback 共享它，重试则是新的（ADR-0020）
      const runId = task.taskId;
      if (!runId) {
        throw new TerminalTaskError('任务缺少 taskId，无法标识本次运行');
      }

      const started = await registry.tryStart(runId, workerId, {
        orphanAfterMs,
        ...(onOrphan === 'fail' ? { maxAttempts: 1 } : {}),
      });

      // ── 别人正在跑：交还任务，下次 callback 再来看 ──
      if (!started.ok && started.reason === 'running') {
        return {
          status: 'IN_PROGRESS',
          callbackAfterSeconds,
          outputData: runningOutput({
            runId,
            attempts: started.record.attempts,
            progress: started.record.progress,
          }),
        };
      }

      // ── 已是终态：读结果直接回执（后台主动回执失败时的兜底路径）──
      if (!started.ok) {
        await registry.drop(runId);
        return finalize(runId, started.record);
      }

      // ── 取得所有权：发起后台运行 ──
      if (started.takeover) {
        logger.warn(
          `[${spec.name}] ${runId} 接管孤儿运行（第 ${started.record.attempts} 次）：` +
            `上一个宿主超过 ${orphanAfterMs}ms 无心跳。整次运行将重新开始。`,
        );
      }

      try {
        const input = await resolveInput(task, deps.externalInputResolver);
        const previousAttempt = previousAttemptOf(task);
        if (!built) built = await engine.build(spec, { logger });

        const reporter = createProgressReporter(deps.taskLogSink?.(task), {
          ...(deps.progress ?? {}),
          ...(deps.logger ? { logger: deps.logger } : {}),
        });
        // 重试换了新 taskId，task log 会断档；把上次 attempt 的落点接上（原生携带的 outputData）
        const prior = (task.outputData?.progress as ProgressReport | undefined);
        if ((task.retryCount ?? 0) > 0 && prior?.step) {
          reporter.report({ ...prior, phase: priorAttemptLine(prior) });
        }

        const source: ConductorSource | undefined = task.workflowInstanceId
          ? {
              workflowInstanceId: task.workflowInstanceId,
              workflowName: task.workflowType ?? '',
              taskId: runId,
              taskReferenceName: task.referenceTaskName ?? '',
              ...(task.correlationId ? { correlationId: task.correlationId } : {}),
              retryCount: task.retryCount ?? 0,
            }
          : undefined;

        host.start({
          runId,
          spec,
          agent: built,
          input: input as JsonValue,
          ...(previousAttempt !== undefined ? { previousAttempt } : {}),
          attempt: task.retryCount ?? 0,
          takeover: started.takeover,
          ...(source ? { source } : {}),
          ...(deps.progress ? { progressOptions: deps.progress } : {}),
          onProgress: (r) => {
            reporter.report(r);
            deps.onProgress?.(task, r);
          },
          onHeartbeat: () => reporter.drain(),
          ...(deps.isWorkflowCancelled && task.workflowInstanceId
            ? { shouldAbort: () => deps.isWorkflowCancelled!(task.workflowInstanceId!) }
            : {}),
          onSettled: async (outcome) => {
            reporter.flush();
            await reporter.drain();
            if (!deps.updateTask || !task.workflowInstanceId) return;
            const mapped = await finalize(runId, outcome).catch((err) =>
              // finalize 对终局错误抛 TerminalTaskError；主动回执路径上翻译成 FAILED
              ({
                status: 'FAILED' as const,
                outputData: failedOutput({
                  runId,
                  error: { name: 'TerminalTaskError', message: String((err as Error).message), retryable: false },
                  progress: outcome.progress,
                }),
                reasonForIncompletion: String((err as Error).message).slice(0, 500),
              }),
            );
            await deps.updateTask({
              taskId: runId,
              workflowInstanceId: task.workflowInstanceId,
              status: mapped.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
              outputData: mapped.outputData ?? {},
              ...(mapped.reasonForIncompletion ? { reasonForIncompletion: mapped.reasonForIncompletion } : {}),
            });
            await registry.drop(runId);
          },
        });
      } catch (err) {
        // 发起失败（输入取不回、引擎构建不出来）：立刻把注册表推向终态，
        // 否则这条 running 记录会一直挂到 orphanAfterMs 才被发现
        const message = (err as Error)?.message ?? String(err);
        const retryable = !(err as Error)?.name?.includes('Terminal') &&
          !(err as Error)?.name?.includes('ExternalInputUnavailable');
        await registry.finish(runId, workerId, {
          status: 'failed',
          error: { name: (err as Error)?.name ?? 'Error', message, retryable },
        });
        throw err;
      }

      return {
        status: 'IN_PROGRESS',
        callbackAfterSeconds,
        outputData: runningOutput({ runId, attempts: started.record.attempts }),
      };
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
  /** 后台宿主，供优雅停机时 drain */
  host: AgentRunHost;
}

/**
 * 把一组 AgentSpec 编译成官方 worker 列表 + 对应 TaskDef。
 *
 * 刻意不在这里 new TaskManager：poll 循环、并发、优雅停机是官方 SDK 的职责，
 * 由调用方决定怎么装配（也便于混用已有的普通 worker）。用法：
 *
 *   const { workers, taskDefs, host } = createAgentWorker({ specs, engines, updateTask });
 *   for (const def of taskDefs) await metadataClient.registerTask(def);
 *   new TaskManager(client, workers, { options: { concurrency: 4 } }).startPolling();
 *   // 停机：manager.stopPolling(); await host.drain();
 */
export function createAgentWorker(options: AgentWorkerOptions): AgentWorker {
  const logger = options.logger ?? noopLogger;
  const workerId = options.workerId ?? `ca-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const registry = options.registry ?? new MemoryRunRegistry();
  const host =
    options.host ??
    new AgentRunHost({
      registry,
      workerId,
      logger,
      ...(options.eventSinks ? { eventSinks: options.eventSinks } : {}),
    });

  const shared: CompileDeps = { ...options, registry, host, workerId, logger };
  const workers = options.specs.map((spec) => compileAgentWorker(spec, shared));
  const taskDefs = options.specs.map((spec) => deriveTaskDef(spec));
  return { workers, taskDefs, host };
}
