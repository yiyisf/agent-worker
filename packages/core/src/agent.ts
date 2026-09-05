/**
 * Agent 定义 —— SDK 的用户入口。
 * 设计说明见 docs/architecture.md §4.1。
 *
 * 占位：仅声明契约，实现随 M1 落地。
 */
import type { AgentProfile, AgentStrategy, BuiltinStrategyId } from './strategy.js';
import type { Guardrail } from './guardrail.js';
import type { ModelRef } from './model.js';
import type { RunContext } from './context.js';
import type { ToolRef } from './tool.js';

/** 结构化 schema 的最小抽象（实现层由 zod / JSON Schema 承载） */
export interface Schema<T> {
  readonly _t?: T;
  validate(value: unknown): { ok: true; value: T } | { ok: false; issues: string[] };
  toJsonSchema(): Record<string, unknown>;
}

export interface AgentLimits {
  /** 推理循环最大步数，默认 12 */
  maxSteps?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  /** 单次运行墙钟上限，默认 300_000；同时用于推导 Conductor TaskDef 超时 */
  wallClockMs?: number;
  perToolTimeoutMs?: number;
}

/** 崩溃后如何续跑，见 docs/architecture.md §5.2 */
export type ResumePolicy = 'on-lease-loss' | 'fresh-per-retry' | 'never';

/**
 * 租约策略，见 ADR-0007 与 ADR-0009。
 * - callback     **默认**。分片执行：IN_PROGRESS + callbackAfterSeconds 交还任务、释放槽位。
 *                Conductor 3.x 全系可用；恢复路径变成每次运行的主路径，因而被高频验证
 * - lease-extend 整个循环在一次 execute() 内跑完，由官方 SDK 的 extendLease 心跳续租。
 *                **要求 Conductor ≥ v3.10.7**
 * - hybrid       计算期 lease-extend、等待期 callback。同样要求 ≥ v3.10.7
 */
export type LeaseStrategy = 'callback' | 'lease-extend' | 'hybrid';

export interface ConductorTaskOptions {
  /** 默认 `agent_<name>` */
  taskType: string;
  domain?: string;
  leaseStrategy: LeaseStrategy;
  /** callback / hybrid 策略下单个切片时长，默认 60_000 */
  leaseSliceMs: number;
  resumePolicy: ResumePolicy;
  /** outputData 体积预算超限后的处理，见 §6.4 */
  payloadStrategy: 'externalize' | 'truncate' | 'fail';
  maxOutputBytes: number;
}

export interface AgentDefinition<I = unknown, O = unknown> {
  name: string;
  version?: number;

  /** 推理策略。字符串取内置策略，或直接传自定义实现。默认 'react'（ADR-0010） */
  strategy?: BuiltinStrategyId | AgentStrategy;
  /** 场景 Profile：预置 strategy/limits/guardrails/conductor 的组合，字段级覆盖 */
  profile?: AgentProfile;

  instructions: string | ((input: I, ctx: RunContext) => string | Promise<string>);
  /** 单个模型或主备链 */
  model: ModelRef | ModelRef[];
  tools?: ToolRef[];
  input?: Schema<I>;
  output?: Schema<O>;
  limits?: AgentLimits;
  guardrails?: Guardrail[];
  conductor?: Partial<ConductorTaskOptions>;
}

export interface AgentResult<O = unknown> {
  ok: boolean;
  result?: O;
  reason?: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  steps: number;
  traceId?: string;
  transcriptRef?: string;
}

/** 宿主无关的运行时入口；Conductor 适配层与本地 CLI 都调用它 */
export interface AgentRuntime {
  run<I, O>(def: AgentDefinition<I, O>, input: I, ctx: RunContext): Promise<AgentResult<O>>;
}
