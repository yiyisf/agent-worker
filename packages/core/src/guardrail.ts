/** 护栏，见 docs/architecture.md §7.1 与 §11。占位：仅声明契约。 */
import type { Message, ModelRequest, ModelResponse } from './model.js';
import type { RunContext } from './context.js';

export type GuardrailStage = 'before-model' | 'after-model' | 'before-tool' | 'after-tool' | 'after-run';

export type GuardrailVerdict<T> =
  | { action: 'allow' }
  | { action: 'rewrite'; value: T }
  | { action: 'block'; rule: string; terminal: boolean };

export interface Guardrail {
  name: string;
  beforeModel?(req: ModelRequest, ctx: RunContext): Promise<GuardrailVerdict<ModelRequest>>;
  afterModel?(res: ModelResponse, ctx: RunContext): Promise<GuardrailVerdict<ModelResponse>>;
  beforeTool?(tool: string, input: unknown, ctx: RunContext): Promise<GuardrailVerdict<unknown>>;
  afterTool?(tool: string, output: unknown, ctx: RunContext): Promise<GuardrailVerdict<unknown>>;
  afterRun?(messages: Message[], output: unknown, ctx: RunContext): Promise<GuardrailVerdict<unknown>>;
}
