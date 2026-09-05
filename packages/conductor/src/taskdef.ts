/**
 * 由 AgentDefinition.limits 推导 Conductor TaskDef，见 docs/architecture.md §6.6。占位。
 *
 * v0.2 关键修正（ADR-0007）：有了 extendLease 心跳之后，responseTimeoutSeconds 应该设**短**：
 *
 *   responseTimeoutSeconds  短（如 60s） = 崩溃检测灵敏度（进程死了心跳就停，60s 内重投）
 *   timeoutSeconds          长（覆盖 wallClockMs） = 总执行上限（心跳不延长它）
 *
 * v0.1 把 responseTimeoutSeconds 设为 wallClock×1.5，会让崩溃后卡满整个租约，已废弃。
 */
import type { AgentDefinition } from '@ca/core';

/** 结构对齐官方 SDK 的 TaskDef，注册时交给官方 MetadataClient */
export interface DerivedTaskDef {
  name: string;
  retryCount: number;
  retryLogic: 'FIXED' | 'EXPONENTIAL_BACKOFF';
  retryDelaySeconds: number;
  /** 总执行上限，由 limits.wallClockMs 推导 */
  timeoutSeconds: number;
  /** 崩溃检测灵敏度；lease-extend/hybrid 下设短，且必须 ≥ 1.25 */
  responseTimeoutSeconds: number;
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
