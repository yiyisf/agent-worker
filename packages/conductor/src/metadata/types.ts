/**
 * 自有的元数据类型，见 docs/architecture.md §6.9 与 ADR-0023。移植自 Claude Projects 版 ca-worker。
 *
 * 目标部署是在 3.21.21 上的定制版本：TaskDef 与 WorkflowDef 都必须带 nameCn（中文名，§2.3 #5）。
 * 官方 SDK 4.0.0 的类型不含该字段，因此不直接复用 SDK 的元数据类型。允许额外字段原样透传。
 */
export type RetryLogic = 'FIXED' | 'EXPONENTIAL_BACKOFF' | 'LINEAR_BACKOFF';
/** 仅作用于 timeoutSeconds；responseTimeout 超时直接 timeoutTask()，不看它（§2.2） */
export type TaskTimeoutPolicy = 'RETRY' | 'TIME_OUT_WF' | 'ALERT_ONLY';
export type WorkflowTimeoutPolicy = 'TIME_OUT_WF' | 'ALERT_ONLY';

/** 公共字段（不含 nameCn）。注意：带索引签名的类型不能用 Omit 派生，会丢失已知字段 */
interface TaskDefFields {
  name: string;
  description?: string;
  ownerEmail: string;
  /** 不可为 0：responseTimeout 超时会判 TIMED_OUT 并消耗一次重试（§2.2） */
  retryCount: number;
  retryLogic: RetryLogic;
  retryDelaySeconds: number;
  /** 总执行上限，从 startTime 起算，必须覆盖所有分片执行 + 所有等待 */
  timeoutSeconds: number;
  responseTimeoutSeconds: number;
  timeoutPolicy: TaskTimeoutPolicy;
  inputKeys: string[];
  outputKeys: string[];
  rateLimitPerFrequency?: number;
  rateLimitFrequencyInSeconds?: number;
  concurrentExecLimit?: number;
  [extra: string]: unknown;
}

export interface CasTaskDef extends TaskDefFields {
  nameCn: string;
}

/** 提交前的形状：requireNameCn: false 时 nameCn 可缺省，必填与否由运行时校验 */
export interface TaskDefInput extends TaskDefFields {
  nameCn?: string;
}

export interface CasWorkflowTask {
  name: string;
  taskReferenceName: string;
  type: string;
  inputParameters?: Record<string, unknown>;
  [extra: string]: unknown;
}

interface WorkflowDefFields {
  name: string;
  version: number;
  schemaVersion: 2;
  description?: string;
  ownerEmail: string;
  timeoutPolicy: WorkflowTimeoutPolicy;
  timeoutSeconds: number;
  tasks: CasWorkflowTask[];
  [extra: string]: unknown;
}

export interface CasWorkflowDef extends WorkflowDefFields {
  nameCn: string;
}

export interface WorkflowDefInput extends WorkflowDefFields {
  nameCn?: string;
}

export function assertNameCn(kind: 'TaskDef' | 'WorkflowDef', def: { name: string; nameCn?: unknown }): void {
  if (typeof def.nameCn !== 'string' || def.nameCn.trim() === '') {
    throw new Error(`${kind} ${def.name} 缺少 nameCn：当前引擎要求该字段必填（对接未定制的 OSS 部署时设 requireNameCn: false）`);
  }
}
