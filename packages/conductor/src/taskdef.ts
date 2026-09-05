/**
 * 由 AgentSpec.limits 推导 Conductor TaskDef，见 docs/architecture.md §6.6。占位。
 *
 * 公式（v0.3，随默认策略改为 callback 而修订）：
 *
 *   # callback（默认）
 *   responseTimeoutSeconds = max(30, ceil(sliceMs/1000 × 3))   // 单片无响应的容忍窗口
 *                                                              // 服务端另加 callbackAfterSeconds，无需为等待留余量
 *                                                              // ⚠️ 30s 下限见下方说明
 *   timeoutSeconds         = ceil(wallClockMs/1000 × 1.2)  // 必须覆盖「所有分片执行 + 所有等待」的总和
 *
 *   # lease-extend / hybrid（要求服务端 ≥ 3.10.7）
 *   responseTimeoutSeconds = 60                            // 故意设短 = 崩溃检测灵敏度；且必须 ≥ 1.25
 *   timeoutSeconds         = ceil(wallClockMs/1000 × 1.2)
 *
 * ⚠️ responseTimeoutSeconds 的 30s 下限（v0.5 新增，源码核实，见 architecture.md §2.2）：
 * 该值不只是「多久判定超时」，**它同时决定 Conductor 重新扫描这个工作流的频率** ——
 * WorkflowSweeper.unack() 在工作流有 IN_PROGRESS 任务时，把 decider 队列的 unack 设为
 * responseTimeoutSeconds + 1 秒。所以把它调小以求「更快发现崩溃」会成比例加重 decider 负载：
 * 设成 10s，该工作流就每 11s 被扫一次；1000 个并发工作流即每秒多出约 90 次扫描。
 * 低于下限时夹到 30s 并告警，而不是默默接受。
 * 顺带：崩溃检测延迟 ≈ responseTimeoutSeconds + 1s，既非 500ms 也非无界。
 *
 * 两条来自服务端源码核实的硬约束（§2.2）：
 *   1. timeoutSeconds 从 startTime 起算且不加 callbackAfterSeconds —— HITL 等一天就得按一天配
 *   2. retryCount 不可为 0 —— responseTimeout 超时会判 TIMED_OUT 并消耗一次重试配额
 *   另注：timeoutPolicy 对 responseTimeout 无效（该路径直接 timeoutTask()），仅作用于 timeoutSeconds
 */
import type { AgentSpec } from '@ca/core';

/** 结构对齐官方 SDK 的 TaskDef，注册时交给官方 MetadataClient */
export interface DerivedTaskDef {
  name: string;
  /** 不可为 0，见上 */
  retryCount: number;
  retryLogic: 'FIXED' | 'EXPONENTIAL_BACKOFF';
  retryDelaySeconds: number;
  /** 总执行上限，含所有 callback 等待 */
  timeoutSeconds: number;
  responseTimeoutSeconds: number;
  /** 仅作用于 timeoutSeconds，对 responseTimeout 无效 */
  timeoutPolicy: 'RETRY' | 'TIME_OUT_WF' | 'ALERT_ONLY';
  concurrentExecLimit?: number;
  rateLimitPerFrequency?: number;
  rateLimitFrequencyInSeconds?: number;
}

export declare function deriveTaskDef(spec: AgentSpec): DerivedTaskDef;

export interface TaskDefDrift {
  name: string;
  field: string;
  local: unknown;
  remote: unknown;
}

/** 启动时校验线上 TaskDef 与本地定义是否漂移；默认告警不阻塞 */
export declare function diffTaskDefs(local: DerivedTaskDef[], remote: DerivedTaskDef[]): TaskDefDrift[];
