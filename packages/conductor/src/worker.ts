/**
 * 用户入口：把 AgentSpec 挂到 Conductor 上。见 docs/architecture.md §6.1。
 *
 * 本层是**薄桥接**（ADR-0006）：poll 循环、并发、心跳、指标、优雅停机全部交给官方
 * `@io-orkes/conductor-javascript` 的 TaskManager；这里只负责把 AgentSpec 编译成
 * 官方的 ConductorWorker，并在 execute 内外接上 journal / fencing / 结果映射 / 取消检测。
 */
import {
  MemoryStateStore,
  assertCapabilities,
  decideResume,
  progressFromJournal,
  runSlice,
} from '@ca/core';
import type {
  AgentEngine,
  AgentSpec,
  BlobStore,
  EventSink,
  JsonValue,
  Logger,
  ProgressReport,
  RunContext,
  StateStore,
} from '@ca/core';
import { checkHandbackBudget } from './lease.js';
import {
  createProgressReporter,
  resumeSummaryLine,
  type ConductorProgressOptions,
  type TaskLogSink,
} from './progress.js';
import { deriveTaskDef, taskTypeOf } from './taskdef.js';
import { TerminalTaskError, toTaskResult, type MappedTaskResult, type ResultMapperOptions } from './result-mapper.js';

/** 官方 Task 的最小形状 —— 只取我们真正用到的字段，避免绑死 SDK 的生成类型 */
export interface ConductorTaskLike {
  taskId?: string;
  workflowInstanceId?: string;
  workflowType?: string;
  referenceTaskName?: string;
  correlationId?: string;
  retryCount?: number;
  startTime?: number;
  inputData?: Record<string, unknown>;
}

/** 官方 ConductorWorker 的形状（v4.0.0） */
export interface CompiledWorker {
  taskDefName: string;
  execute: (task: ConductorTaskLike) => Promise<MappedTaskResult>;
  domain?: string;
  concurrency?: number;
  pollInterval?: number;
  leaseExtendEnabled?: boolean;
}

/** 恢复用的外部结果（如审批决定）从任务输入的这个约定字段读入 */
export const RESUME_INPUT_KEY = '__caResume';

export interface CompileDeps {
  engines: readonly AgentEngine<never>[];
  stateStore: StateStore;
  blobStore?: BlobStore;
  eventSinks?: readonly EventSink[];
  logger?: Logger;
  workerId?: string;
  /**
   * 进展的**尽力而为**通道（§10.4）：通常包一层官方 SDK 的 getTaskContext()?.addLog。
   * 不提供则只写权威通道 outputData.progress。
   */
  taskLogSink?: (task: ConductorTaskLike) => TaskLogSink | undefined;
  progress?: ConductorProgressOptions;
  /** 额外的进展观察点（自建监控、StreamSink 等） */
  onProgress?: (task: ConductorTaskLike, report: ProgressReport) => void;
  /** 取消检测：返回 true 表示该工作流已终止，应中止本次运行（§6.4） */
  isWorkflowCancelled?: (workflowInstanceId: string) => Promise<boolean>;
  resultMapper?: ResultMapperOptions;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** runKey：恢复的锚点（§5.2）。epoch 由 resumePolicy 决定 */
export function runKeyOf(spec: AgentSpec, task: ConductorTaskLike): string {
  const policy = spec.conductor?.resumePolicy ?? 'on-lease-loss';
  const epoch = policy === 'fresh-per-retry' ? (task.retryCount ?? 0) : 0;
  return `${task.workflowInstanceId ?? 'wf'}:${task.referenceTaskName ?? spec.name}:${epoch}`;
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

  const lease = spec.conductor?.leaseStrategy ?? 'callback';
  if (lease !== 'lease-extend' && deps.stateStore instanceof MemoryStateStore) {
    throw new Error(
      `leaseStrategy='${lease}' 需要持久化 StateStore，但传入的是内存实现。` +
        `内存实现只供本地开发 —— 分片一旦跨进程就会丢状态。请改用 @ca/memory 的 RedisStateStore。`,
    );
  }

  const taskDef = deriveTaskDef(spec);
  const workerId = deps.workerId ?? `ca-${process.pid}`;
  const emit = (e: Parameters<EventSink['handle']>[0]) => {
    for (const sink of deps.eventSinks ?? []) void sink.handle(e);
  };

  let built: Awaited<ReturnType<typeof engine.build>> | undefined;

  return {
    taskDefName: taskTypeOf(spec),
    ...(spec.conductor?.domain ? { domain: spec.conductor.domain } : {}),
    ...(lease !== 'callback' ? { leaseExtendEnabled: true } : {}),

    async execute(task: ConductorTaskLike): Promise<MappedTaskResult> {
      const runKey = runKeyOf(spec, task);
      const now = Date.now();

      // ── 抢占租约。抢不到说明别人正持有，立刻交还，不要并发跑（§5.3）──
      const held = await deps.stateStore.acquire(runKey, workerId, taskDef.responseTimeoutSeconds * 1000);
      if (!held) {
        logger.warn(`[${spec.name}] ${runKey} 已被其它 worker 持有，交还任务`);
        return { status: 'IN_PROGRESS', callbackAfterSeconds: 5, outputData: { state: 'contended' } };
      }

      try {
        // ── 取消检测：工作流已终止就别再烧 token（§6.4）──
        if (deps.isWorkflowCancelled && task.workflowInstanceId) {
          if (await deps.isWorkflowCancelled(task.workflowInstanceId)) {
            throw new TerminalTaskError('所属工作流已终止，放弃本次运行');
          }
        }

        // ── 恢复判据：看自己的 journal 有没有终态，不看 retryCount（ADR-0016）──
        const history = await deps.stateStore.readJournal(runKey);
        const decision = decideResume(history, spec.conductor?.resumePolicy ?? 'on-lease-loss');
        if (decision.action === 'restart' && history.length > 0) {
          logger.info(`[${spec.name}] ${runKey} 重开：${decision.reason}`);
          await deps.stateStore.dropJournal(runKey);
        }

        if (!built) built = await engine.build(spec, { logger });

        const controller = new AbortController();
        const wallClockMs = spec.limits?.wallClockMs ?? 300_000;
        const ctx: RunContext = {
          runKey,
          runId: `${runKey}#${task.taskId ?? 'no-task'}`,
          attempt: task.retryCount ?? 0,
          sliceIndex: 0,
          startedAt: task.startTime && task.startTime > 0 ? task.startTime : now,
          deadline: (task.startTime && task.startTime > 0 ? task.startTime : now) + wallClockMs,
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
          ...(task.workflowInstanceId
            ? {
                source: {
                  workflowInstanceId: task.workflowInstanceId,
                  workflowName: task.workflowType ?? '',
                  taskId: task.taskId ?? '',
                  taskReferenceName: task.referenceTaskName ?? '',
                  ...(task.correlationId ? { correlationId: task.correlationId } : {}),
                  retryCount: task.retryCount ?? 0,
                },
              }
            : {}),
        };

        const resumeWith = task.inputData?.[RESUME_INPUT_KEY] as JsonValue | undefined;

        // ── 进展反馈（§10.4 / ADR-0018）──
        const progress = createProgressReporter(deps.taskLogSink?.(task), {
          ...(deps.progress ?? {}),
          ...(deps.logger ? { logger: deps.logger } : {}),
        });
        // 跨 taskId 重试会让 task log 断档（log 挂在 taskId 上，callback 交还不换 taskId），
        // 所以新 task 实例的第一条日志把断点接上
        if ((task.retryCount ?? 0) > 0) {
          const prior = progressFromJournal(history);
          if (prior && prior.step > 0) progress.report({ ...prior, phase: resumeSummaryLine(prior) });
        }

        const outcome = await runSlice({
          spec,
          agent: built,
          input: (task.inputData?.input ?? task.inputData ?? null) as JsonValue,
          ctx,
          store: deps.stateStore,
          lease: held,
          ...(resumeWith !== undefined ? { resumeWith } : {}),
          onProgress: (r) => {
            progress.report(r);
            deps.onProgress?.(task, r);
          },
        });

        // 分片边界把被节流压住的最后一条吐出来，再统一推给 Conductor
        progress.flush();
        await progress.drain();

        // ── 交还预算：真正的约束是 Σ(执行 + 等待) < timeoutSeconds（§2.2）──
        let callbackAfterSeconds: number | undefined;
        if (outcome.kind === 'continue' || outcome.kind === 'suspended') {
          const requested =
            outcome.kind === 'suspended'
              ? (outcome.awaiting.suggestedCallbackAfterSeconds ?? 30)
              : 1;
          const budgeted = checkHandbackBudget({
            requestedCallbackAfterSeconds: requested,
            taskStartTimeMs: ctx.startedAt,
            timeoutSeconds: taskDef.timeoutSeconds,
            now: Date.now(),
          });
          if (budgeted.willExceedTotalTimeout) {
            logger.warn(
              `[${spec.name}] ${runKey} 请求交还 ${requested}s 会撞上 timeoutSeconds=${taskDef.timeoutSeconds}，` +
                `已夹到 ${budgeted.seconds}s。长等待场景需要相应放大 wallClockMs。`,
            );
          }
          callbackAfterSeconds = budgeted.seconds;
        } else {
          // 终态：把租约让出来，下一个 runKey 不必等自然过期
          await deps.stateStore.release(held);
        }

        return await toTaskResult(
          {
            outcome,
            ...(callbackAfterSeconds !== undefined ? { callbackAfterSeconds } : {}),
            ...(progress.snapshot()
              ? { progress: progress.snapshot() as unknown as JsonValue }
              : {}),
          },
          deps.resultMapper ?? {},
        );
      } catch (err) {
        // fence 落后就是别人接管了：不回写任何结果，交还任务让新 owner 继续
        if ((err as Error)?.name === 'FencedOutError') {
          logger.warn(`[${spec.name}] ${runKey} fence 落后，放弃回写`);
          return { status: 'IN_PROGRESS', callbackAfterSeconds: 5, outputData: { state: 'fenced-out' } };
        }
        throw err;
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
 * 刻意不在这里 new TaskManager：poll 循环、并发、优雅停机是官方 SDK 的职责，
 * 由调用方决定怎么装配（也便于混用已有的普通 worker）。用法：
 *
 *   const { workers, taskDefs } = createAgentWorker({ specs, engines, stateStore });
 *   await metadataClient.registerTaskDefs(taskDefs);
 *   new TaskManager(client, workers, { options: { concurrency: 4 } }).startPolling();
 */
export function createAgentWorker(options: AgentWorkerOptions): AgentWorker {
  const workers = options.specs.map((spec) => compileAgentWorker(spec, options));
  const taskDefs = options.specs.map((spec) => deriveTaskDef(spec));
  return { workers, taskDefs };
}
