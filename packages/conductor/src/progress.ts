/**
 * 把进展写回 Conductor，见 docs/architecture.md §10.4 与 ADR-0018。
 *
 * 两条通道，可靠性分级：
 *
 *   通道一 outputData.progress（**权威**）
 *     callback 分片交还本身就是一次 task update，顺手把 ProgressReport 写进 outputData，
 *     零额外请求。这是唯一能被工作流消费的通道 —— 其他 task 可读
 *     ${agent_ref.output.progress.step} 做 SWITCH 分支、超时告警或通知。
 *     由 result-mapper 负责，不在本文件。
 *
 *   通道二 Conductor Task Log（**尽力而为**）
 *     经官方 SDK 的 getTaskContext()?.addLog()，优点是分片内也能写、不必等交还。
 *     但受三条服务端约束（v3.21.21 源码核实），只当作 UI 上的镜像，丢了不算故障。
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
  /** 通常是官方 SDK 的 getTaskContext()?.addLog；一次最多 10 条 */
  addLogs(lines: string[]): Promise<void> | void;
}

export interface ConductorProgressOptions extends ProgressOptions {
  logger?: Logger;
  /**
   * 启动自检：探测部署是否真的会保存 task log。
   * conductor.indexing.enabled=false 时服务端用 NoopIndexDAO，**日志被静默丢弃** ——
   * 返回 false 则自动关闭通道二并告警一次，不能让用户以为写了、其实什么都没有。
   */
  taskLogAvailable?: boolean;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function truncate(s: string): string {
  return s.length <= TASK_LOG_LIMITS.maxChars ? s : `${s.slice(0, TASK_LOG_LIMITS.maxChars - 1)}…`;
}

/**
 * 一行结构化文本，**不放 payload、不放工具入参出参、不放任何密钥**。
 * 例：`[3/12] tool:lookupPolicy · 12.4k tok / $0.031 · slice 2`
 */
export function formatProgressLine(r: ProgressReport): string {
  const steps = r.totalSteps !== undefined ? `${r.step}/${r.totalSteps}` : String(r.step);
  const tok = r.usage.tokens >= 1000 ? `${(r.usage.tokens / 1000).toFixed(1)}k` : String(r.usage.tokens);
  const cost = r.usage.costUsd > 0 ? ` / $${r.usage.costUsd.toFixed(4)}` : '';
  return truncate(`[${steps}] ${r.phase} · ${tok} tok${cost} · slice ${r.sliceIndex}`);
}

/**
 * 跨重试的连续性：task log 挂在 taskId 上。callback 交还不换 taskId，分片间连续；
 * 但 responseTimeout → TIMED_OUT → 重试会换新 taskId，日志就断了。
 * 新 taskId 的第一条 log 由本函数生成，把断点接上。
 */
export function resumeSummaryLine(prev: ProgressReport): string {
  const tok = prev.usage.tokens >= 1000 ? `${(prev.usage.tokens / 1000).toFixed(1)}k` : String(prev.usage.tokens);
  const cost = prev.usage.costUsd > 0 ? ` / $${prev.usage.costUsd.toFixed(4)}` : '';
  return truncate(`↻ 从第 ${prev.step} 步恢复（已累计 ${tok} tok${cost}，slice ${prev.sliceIndex}）`);
}

export interface ConductorProgressReporter extends ProgressReporter {
  /** 把攒下的日志真正推给 Conductor；失败只记本地日志，不影响主流程 */
  drain(): Promise<void>;
  /** 通道二是否可用（探测不可用时为 false） */
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
  const enabled = sink !== undefined && opts.taskLogAvailable !== false;

  if (sink !== undefined && opts.taskLogAvailable === false) {
    // 只告警一次：这是部署配置问题，不是每次运行都要吼一遍的事
    logger.warn(
      '部署未启用 task log 索引（conductor.indexing.enabled=false → NoopIndexDAO），' +
        '进展的 Task Log 通道已自动关闭。outputData.progress 仍然可用，它才是权威通道。',
    );
  }

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
      for (const batch of batches) {
        try {
          await sink!.addLogs(batch);
        } catch (err) {
          // 进展丢了不算故障 —— 权威通道是 outputData.progress
          logger.warn(`写 task log 失败，已跳过 ${batch.length} 条：${(err as Error)?.message}`);
        }
      }
    },
  };
}
