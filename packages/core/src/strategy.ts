/**
 * 可插拔的推理策略，见 docs/architecture.md §4.3 L3 与 ADR-0010。占位：仅声明契约。
 *
 * 设计核心：**策略只做决策，不做执行**。
 * 策略返回 StepPlan（意图），由 Runtime 去执行、写 journal、做幂等、扣预算、跑护栏、记 span。
 * 因此任何自定义策略都零成本继承全部可靠性机制 —— 这是本 SDK 相对「自己写个 while 循环」的核心价值。
 *
 * @stability experimental —— v1 期间允许在 minor 版本破坏，见 ADR-0010
 */
import type { AgentDefinition } from './agent.js';
import type { RunContext, SuspendRequest } from './context.js';
import type { ModelRequest, ModelResponse } from './model.js';
import type { SerializedError } from './journal.js';

export type BuiltinStrategyId =
  /** 思考 → 工具 → 观察 循环。默认 */
  | 'react'
  /** 先出计划，再按依赖图执行 */
  | 'plan-execute'
  /** 产出 → 自评 → 修订 */
  | 'reflect'
  /** 一次调用 + 强制结构化输出，无工具。抽取/分类/打标的最低成本形态 */
  | 'single-shot'
  /** 分类后转交子 Agent */
  | 'router';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** 策略返回的「下一步意图」，由 Runtime 执行 */
export type StepPlan =
  | { kind: 'model'; request: ModelRequest }
  | { kind: 'tools'; calls: ToolCall[]; parallel?: boolean }
  | { kind: 'suspend'; req: SuspendRequest }
  | { kind: 'done'; output: unknown };

/** Runtime 执行 StepPlan 之后回灌给策略的结果 */
export type StepOutcome =
  | { kind: 'model'; response: ModelResponse }
  | { kind: 'tools'; results: Array<{ id: string; output?: unknown; error?: SerializedError }> }
  | { kind: 'resumed'; payload: unknown };

/**
 * 状态恢复模式（callback 分片与崩溃恢复都要用）：
 * - 'replay'   默认。要求 init/reduce 为纯函数，状态由 journal 重放重建，无额外存储
 * - 'snapshot' 状态需可 JSON 序列化，每步写一条 snapshot journal entry；适合 reduce 昂贵的策略
 */
export type StateRecovery = 'replay' | 'snapshot';

export interface AgentStrategy<S = unknown> {
  name: string;
  recovery?: StateRecovery;

  init(def: AgentDefinition, input: unknown, ctx: RunContext): Promise<S>;
  /** 只做决策。拿不到直接调用 LLM / 工具的句柄，因此不会破坏重放（ADR-0003） */
  next(state: S, ctx: RunContext): Promise<StepPlan>;
  /** 把执行结果并回状态。必须是纯函数 —— 'replay' 模式的正确性依赖于此 */
  reduce(state: S, outcome: StepOutcome): S;
  finalize(state: S, ctx: RunContext): Promise<unknown>;
}

/**
 * 场景 Profile：把「策略 + 限额 + 护栏 + 租约 + payload 策略」打包复用，字段级可覆盖。
 * 内置参考：data-extraction / research / ops-runbook
 */
export interface AgentProfile
  extends Partial<Pick<AgentDefinition, 'strategy' | 'limits' | 'guardrails' | 'conductor'>> {
  name: string;
}

export declare function defineProfile(profile: AgentProfile): AgentProfile;
