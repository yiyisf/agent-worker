/**
 * 由 AgentDefinition.limits 推导 Conductor TaskDef，见 docs/architecture.md §6.6。占位。
 *
 * 公式（v0.3，随默认策略改为 callback 而修订）：
 *
 *   # callback（默认）
 *   responseTimeoutSeconds = ceil(leaseSliceMs/1000 × 3)   // 单片无响应的容忍窗口
 *                                                          // 服务端另加 callbackAfterSeconds，无需为等待留余量
 *   timeoutSeconds         = ceil(wallClockMs/1000 × 1.2)  // 必须覆盖「所有分片执行 + 所有等待」的总和
 *
 *   # lease-extend / hybrid（要求服务端 ≥ 3.10.7）
 *   responseTimeoutSeconds = 60                            // 故意设短 = 崩溃检测灵敏度；且必须 ≥ 1.25
 *   timeoutSeconds         = ceil(wallClockMs/1000 × 1.2)
 *
 * 两条来自服务端源码核实的硬约束（§2.2）：
 *   1. timeoutSeconds 从 startTime 起算且不加 callbackAfterSeconds —— HITL 等一天就得按一天配
 *   2. retryCount 不可为 0 —— responseTimeout 超时会判 TIMED_OUT 并消耗一次重试配额
 *   另注：timeoutPolicy 对 responseTimeout 无效（该路径直接 timeoutTask()），仅作用于 timeoutSeconds
 */
import type { AgentDefinition } from '@ca/core';

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

export declare function deriveTaskDef(def: AgentDefinition): DerivedTaskDef;

export interface TaskDefDrift {
  name: string;
  field: string;
  local: unknown;
  remote: unknown;
}

/** 启动时校验线上 TaskDef 与本地定义是否漂移；默认告警不阻塞 */
export declare function diffTaskDefs(local: DerivedTaskDef[], remote: DerivedTaskDef[]): TaskDefDrift[];
