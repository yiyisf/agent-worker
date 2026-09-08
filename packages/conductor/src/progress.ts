/**
 * 把进展写回 Conductor，见 docs/architecture.md §10.4 与 ADR-0018 / ADR-0022。
 *
 * ⚠️ extendLease 模式下两条通道的角色是这样的：
 *
 *   通道一 outputData.progress（权威，但**只在终态**）
 *     任务结束时随结果写一次，零额外请求。工作流可以事后读
 *     ${agent_ref.output.progress} 与 .usage 做分支或成本归集。由 task-io 负责，不在本文件。
 *     运行**中**读不到 —— extendLease 心跳在写 outputData 之前就 return 了，
 *     而正常的 updateTask(IN_PROGRESS) 会把任务写回队列、破坏 worker 亲和。
 *
 *   通道二 Conductor Task Log（**运行中唯一可见**，尽力而为）
 *     经官方 SDK 的 TaskClient.addTaskLog —— 它**不碰队列**，所以运行途中随时可写。
 *     由 worker 的周期任务批量推出去。但受三条服务端约束（v3.21.21 源码核实），
 *     部署没启用索引时会被静默丢弃，所以是尽力而为的。
 *
 * 心跳与本模块无关 —— 那是官方 LeaseTracker 的事。
 */
import { createThrottledReporter, type ProgressOptions, type ProgressReport, type ProgressReporter } from '@ca/core';
import type { Logger } from '@ca/core';

/** 服务端约束（ExecutionDAOFacade.addTaskExecLog / ConductorProperties） */
export const TASK_LOG_LIMITS = {
  /**
   * taskExecLogSizeLimit 默认 10：**单次调用**超出会被
   * `logs.stream().limit(10)` 静默截断，不是每任务上限。
   */
  maxLogsPerCall: 10,
  /** 单条日志的截断长度：日志是给人看的，不该塞 payload */
  maxChars: 512,
  /** asyncIndexingEnabled 默认 false → 索引写在请求路径上，写太频会拖慢服务端 */
  writeIsOnRequestPath: true,
} as const;

export interface TaskLogSink {
  /** 通常是官方 SDK 的 TaskClient.addTaskLog；一次最多 10 条 */
  addLogs(lines: string[]): Promise<void> | void;
  /**
   * 可选：把日志读回来（`TaskClient.getTaskLogs`）。
   *
   * 提供了它，reporter 会在**第一次成功写入之后**做一次实测：读回来是空的
   * 就说明这个部署根本不存 task log（`conductor.indexing.enabled=false` →
   * `NoopIndexDAO` 静默丢弃），于是自动关闭本通道并**告警一次**。
   *
   * 为什么要实测而不是读配置：`/admin/config` 返回的是 `System.getProperties()`，
   * 而 `conductor.indexing.enabled` 通常来自 `application.properties` 或环境变量 ——
   * 那里读不到。只有写一条再读回来才是可靠的。
   */
  readLogs?(): Promise<unknown[]>;
}

export interface ConductorProgressOptions extends ProgressOptions {
  logger?: Logger;
  /**
   * 显式开关。`false` 直接关闭本通道（比如你已经知道部署没启索引）；
   * 不传则由 `TaskLogSink.readLogs` 的一次性实测决定（没提供 readLogs 就一直开着）。
   */
  taskLogAvailable?: boolean;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function truncate(s: string): string {
  return s.length <= TASK_LOG_LIMITS.maxChars ? s : `${s.slice(0, TASK_LOG_LIMITS.maxChars - 1)}…`;
}

function fmtUsage(u: ProgressReport['usage']): string {
  const tok = u.tokens >= 1000 ? `${(u.tokens / 1000).toFixed(1)}k` : String(u.tokens);
  return `${tok} tok${u.costUsd > 0 ? ` / $${u.costUsd.toFixed(4)}` : ''}`;
}

/**
 * 一行结构化文本，**不放 payload、不放工具入参出参、不放任何密钥**。
 * 例：`[3/12] tool:lookupPolicy · 12.4k tok / $0.031`
 */
export function formatProgressLine(r: ProgressReport): string {
  const steps = r.totalSteps !== undefined ? `${r.step}/${r.totalSteps}` : String(r.step);
  return truncate(`[${steps}] ${r.phase} · ${fmtUsage(r.usage)}`);
}

/**
 * 跨重试的连续性：task log 挂在 taskId 上，而重试会换新 taskId，日志就断了。
 * 上一次 attempt 的进展由 Conductor 原生带在 task.outputData.progress 里，
 * 新 taskId 的第一条 log 由本函数生成，把断点接上。
 */
export function priorAttemptLine(prev: ProgressReport): string {
  return truncate(`↻ 上次 attempt 停在第 ${prev.step} 步（${fmtUsage(prev.usage)}），本次重新开始`);
}

export interface ConductorProgressReporter extends ProgressReporter {
  /** 把攒下的日志真正推给 Conductor；失败只记本地日志，不影响主流程 */
  drain(): Promise<void>;
  /** 本通道是否可用（显式关闭、或实测发现日志没被存下来时为 false） */
  readonly taskLogEnabled: boolean;
}

/**
 * 通道二的写入器。节流与合并由 core 的 createThrottledReporter 负责，
 * 这里只管「攒够了怎么写、写不动怎么降级」。
 */
export function createProgressReporter(
  sink: TaskLogSink | undefined,
  opts: ConductorProgressOptions = {},
  now: () => number = Date.now,
): ConductorProgressReporter {
  const logger = opts.logger ?? noopLogger;
  let enabled = sink !== undefined && opts.taskLogAvailable !== false;
  let verified = false;

  if (sink !== undefined && opts.taskLogAvailable === false) {
    // 只告警一次：这是部署配置问题，不是每次运行都要吼一遍的事
    logger.warn(
      'task log 通道被显式关闭（taskLogAvailable=false）。运行途中将看不到进展，' +
        '终态的 outputData.progress 仍然有值。',
    );
  }

  /**
   * 一次性实测：写完第一批之后读回来。空的就说明部署根本不存
   * （conductor.indexing.enabled=false → NoopIndexDAO 静默丢弃）。
   * 读失败**不**当作不可用 —— 网络抖动不该让通道被误关。
   */
  const verifyOnce = async (): Promise<void> => {
    if (verified || !sink?.readLogs) return;
    verified = true;
    try {
      const back = await sink.readLogs();
      if (Array.isArray(back) && back.length === 0) {
        enabled = false;
        logger.warn(
          '实测发现写入的 task log 没有被保存（读回来是空的）——' +
            '该部署多半未启用索引（conductor.indexing.enabled=false → NoopIndexDAO）。' +
            '本通道已自动关闭，运行途中将看不到进展；终态的 outputData.progress 仍然有值。',
        );
      }
    } catch (err) {
      logger.debug?.(`task log 自检读取失败，保持通道开启：${(err as Error)?.message}`);
    }
  };

  const buffer: string[] = [];
  const throttled = createThrottledReporter(
    (r) => {
      if (!enabled) return;
      buffer.push(formatProgressLine(r));
    },
    opts,
    now,
  );

  return {
    get taskLogEnabled() {
      return enabled;
    },
    report: throttled.report,
    snapshot: throttled.snapshot,
    flush: throttled.flush,
    async drain(): Promise<void> {
      if (!enabled || buffer.length === 0) return;
      // 单次调用超过 10 条会被服务端静默截断，所以按 10 条一批发
      const batches: string[][] = [];
      while (buffer.length > 0) batches.push(buffer.splice(0, TASK_LOG_LIMITS.maxLogsPerCall));
      let wroteSomething = false;
      for (const batch of batches) {
        try {
          await sink!.addLogs(batch);
          wroteSomething = true;
        } catch (err) {
          // 进展丢了不算故障 —— 终态的 outputData.progress 才是权威通道
          logger.warn(`写 task log 失败，已跳过 ${batch.length} 条：${(err as Error)?.message}`);
        }
      }
      if (wroteSomething) await verifyOnce();
    },
  };
}
