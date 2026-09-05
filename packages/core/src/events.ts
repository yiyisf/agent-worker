/** 事件是可观测性 / 流式输出 / 审计的唯一数据源，见 docs/architecture.md §4.5。占位。 */
import type { ModelDelta, ModelRequest, ModelResponse } from './model.js';
import type { GuardrailStage } from './guardrail.js';
import type { StepKind } from './journal.js';

export type AgentEvent =
  | { type: 'run.started'; runKey: string; agent: string; input: unknown }
  | { type: 'step.started'; index: number; kind: StepKind }
  | { type: 'model.request'; stepId: string; request: ModelRequest }
  | { type: 'model.delta'; stepId: string; delta: ModelDelta }
  | { type: 'model.response'; stepId: string; response: ModelResponse }
  | { type: 'tool.started'; stepId: string; name: string; input: unknown }
  | { type: 'tool.succeeded'; stepId: string; name: string; durationMs: number }
  | { type: 'tool.failed'; stepId: string; name: string; error: string; retryable: boolean }
  | { type: 'guardrail.blocked'; rule: string; stage: GuardrailStage }
  | { type: 'budget.exceeded'; metric: 'tokens' | 'cost' | 'time' | 'steps' }
  | { type: 'run.suspended'; runKey: string; reason: string; resumeToken: string }
  | { type: 'run.resumed'; runKey: string; fromSeq: number }
  | { type: 'run.finished'; runKey: string; outcome: 'ok' | 'error'; durationMs: number };

export interface EventSink {
  handle(event: AgentEvent): void | Promise<void>;
}
