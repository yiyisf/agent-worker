/**
 * 标准出入参信封，见 docs/architecture.md §6.8 与 ADR-0020。
 *
 * 能力专属字段只出现在 payload / result；平台字段由信封承载；
 * Conductor 系统字段（taskId、workflowInstanceId、retryCount、referenceTaskName）不进入 input，
 * 由桥接层注入 RunContext。
 *
 * 移植自 Claude Projects 版 ca-worker，按本仓库架构调整：
 *   run.framework → run.engine；新增 run.specHash / run.slices；resumedFromCheckpoint → resumed；
 *   compactions 改为可选；Usage 与 @ca/core 对齐（cachedInputTokens）；新增 AgentTaskInterimOutput。
 */
import type { ProgressReport } from '@ca/core';

export const SCHEMA_VERSION = '1' as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

export const ARTIFACT_KINDS = ['file', 'diff', 'report', 'log', 'transcript', 'data'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactRef {
  uri: string;
  /** transcript 以 kind: 'transcript' 出现，不另设字段 */
  kind: ArtifactKind;
  name: string;
  mediaType: string;
  sizeBytes: number;
  /** 十六进制 SHA-256，用于内容校验与重试时判断产物是否已存在 */
  sha256: string;
  description?: string;
}

/** AgentTaskOutput 的结构子集，workflow 可直接把上游 output 字段映射为下游 handoff */
export interface Handoff {
  fromRef: string;
  summary: string;
  artifacts: ArtifactRef[];
  result?: unknown;
}

export type Reasoning = 'low' | 'medium' | 'high';

/** 与 spec.limits 合并，只能收紧不能放宽（ADR-0020） */
export interface ExecutionOverrides {
  /** 必须在 spec 的模型白名单内 */
  model?: string;
  reasoning?: Reasoning;
  maxSteps?: number;
  budget?: { maxTokens?: number; maxCostUsd?: number };
  /** 必须小于 TaskDef timeoutSeconds */
  timeoutMs?: number;
}

export interface TraceContext {
  traceparent?: string;
  tenantId?: string;
  correlationId?: string;
}

export interface AgentTaskInput<P> {
  schemaVersion: SchemaVersion;
  payload: P;
  /** 追加在 spec 系统提示之后，不能替换 */
  instructions?: string;
  context?: { handoffs?: Handoff[]; artifacts?: ArtifactRef[] };
  execution?: ExecutionOverrides;
  trace?: TraceContext;
}

export const OUTCOMES = ['completed', 'needs_approval', 'needs_input', 'escalated'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface AgentTaskRequest {
  reason: string;
  question?: string;
  proposal?: unknown;
}

/** 与 @ca/core 的 Usage 对齐，另加 toolCalls */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  toolCalls: number;
  costUsd?: number;
}

export const STOP_REASONS = ['done', 'max_steps', 'budget', 'timeout'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface RunInfo {
  runId: string;
  agent: string;
  /** AgentEngine id，如 'ai-sdk/tool-loop' */
  engine: string;
  model: string;
  /** effective spec 的 hash，全文在 journal（§7.2） */
  specHash: string;
  steps: number;
  /** callback 分片数 */
  slices: number;
  durationMs: number;
  attempt: number;
  /** 是否经 journal 重放续跑（ADR-0016） */
  resumed: boolean;
  /** 引擎上报时才有；拦截式架构下 core 不一定知道 */
  compactions?: number;
  stopReason: StopReason;
}

export const AGENT_ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_OUTPUT',
  'BUDGET_EXCEEDED',
  'TIMEOUT',
  'MODEL_RATE_LIMIT',
  'MODEL_UNAVAILABLE',
  'TOOL_FAILED',
  'POLICY_DENIED',
  'CANCELLED',
  'FENCED',
  'INTERNAL',
] as const;
export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

/** 运行结束（含业务信号）时的 output；Conductor 状态为 COMPLETED */
export interface AgentTaskOutput<R> {
  schemaVersion: SchemaVersion;
  outcome: Outcome;
  result?: R;
  summary: string;
  artifacts: ArtifactRef[];
  request?: AgentTaskRequest;
  usage: Usage;
  run: RunInfo;
}

/** 运行失败时的 output；Conductor 状态为 FAILED 或 FAILED_WITH_TERMINAL_ERROR */
export interface AgentTaskFailureOutput {
  schemaVersion: SchemaVersion;
  error: AgentError;
  summary?: string;
  usage: Usage;
  run: RunInfo;
}

/** 分片交还、等待审批、保活心跳时的 output；Conductor 状态为 IN_PROGRESS（ADR-0018 的权威进展通道） */
export interface AgentTaskInterimOutput {
  schemaVersion: SchemaVersion;
  progress: ProgressReport;
}
