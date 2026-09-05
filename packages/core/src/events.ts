/** 事件是可观测性 / 流式输出 / 审计的唯一数据源，见 docs/architecture.md §10。占位。 */
import type { JsonValue } from './spec.js';
import type { Usage } from './gateway.js';

export type AgentEvent =
  | { type: 'run.started'; runKey: string; spec: string; engine: string; specHash: string }
  | { type: 'slice.started'; index: number }
  | { type: 'slice.handback'; index: number; reason: 'continue' | 'suspended'; callbackAfterSeconds: number }
  /** replayed=true 表示由 journal 短路，未产生真实调用 */
  | { type: 'model.call'; stepId: string; replayed: boolean; usage?: Usage }
  | { type: 'model.delta'; stepId: string; delta: JsonValue }
  | { type: 'tool.started'; stepId: string; name: string; replayed: boolean }
  | { type: 'tool.succeeded'; stepId: string; name: string; durationMs: number }
  | { type: 'tool.failed'; stepId: string; name: string; error: string; retryable: boolean }
  /** 进展（§10.4）—— 低频有界，区别于 model.delta 的实时流 */
  | { type: 'progress'; phase: string; step: number; totalSteps?: number; sliceIndex: number }
  | { type: 'guardrail.blocked'; rule: string; stage: string }
  | { type: 'budget.exceeded'; metric: 'tokens' | 'cost' | 'time' | 'toolCalls' }
  /** 引擎能力不足导致的降级，务必可观测（§4.4） */
  | { type: 'capability.degraded'; engine: string; capability: string; effect: string }
  | { type: 'run.finished'; runKey: string; outcome: 'ok' | 'error'; slices: number; durationMs: number };

export interface EventSink {
  handle(event: AgentEvent): void | Promise<void>;
}
