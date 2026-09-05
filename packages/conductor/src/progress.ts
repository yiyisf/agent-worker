/**
 * 把进展写回 Conductor，见 docs/architecture.md §10.4 与 ADR-0018。占位：仅声明契约。
 *
 * 两条通道，可靠性分级：
 *
 *   通道一 outputData.progress（**权威**）
 *     callback 分片交还本身就是一次 task update，顺手把 ProgressReport 写进 outputData，
 *     零额外请求。这是唯一能被工作流消费的通道 —— 其他 task 可读
 *     ${agent_ref.output.progress.step} 做 SWITCH 分支、超时告警或通知。
 *
 *   通道二 Conductor Task Log（**尽力而为**）
 *     经官方 SDK 的 getTaskContext()?.addLog()，优点是分片内也能写、不必等交还。
 *     但受三条服务端约束（v3.21.21 源码核实），只当作 UI 上的镜像，丢了不算故障。
 */
import type { ProgressOptions, ProgressReport, ProgressReporter } from '@ca/core';

/** 服务端约束（ExecutionDAOFacade.addTaskExecLog / ConductorProperties） */
export const TASK_LOG_LIMITS = {
  /** taskExecLogSizeLimit 默认 10：**单次调用**超出会被静默截断，不是每任务上限 */
  maxLogsPerCall: 10,
  /** asyncIndexingEnabled 默认 false → 索引写在请求路径上，写太频会拖慢服务端 */
  writeIsOnRequestPath: true,
} as const;

/**
 * 启动自检：探测部署是否真的会保存 task log。
 * conductor.indexing.enabled=false 时服务端用 NoopIndexDAO，**日志被静默丢弃** ——
 * 未启用则告警一次并自动关闭通道二，不能让用户以为写了、其实什么都没有。
 */
export declare function probeTaskLogAvailability(): Promise<{ enabled: boolean; reason?: string }>;

export interface ConductorProgressOptions extends ProgressOptions {
  /** 通道二不可用时是否静默降级（默认 true，并告警一次） */
  degradeSilently?: boolean;
}

export declare function createProgressReporter(
  opts: ConductorProgressOptions,
): ProgressReporter;

/**
 * 跨重试的连续性：task log 挂在 taskId 上。callback 交还不换 taskId，分片间连续；
 * 但 responseTimeout → TIMED_OUT → 重试会换新 taskId，日志断开。
 * 因此进展同时写 journal，新 taskId 的第一条 log 由本函数生成，把断点接上。
 */
export declare function resumeSummaryLine(prev: ProgressReport): string;
