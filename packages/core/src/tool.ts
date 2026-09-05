/** 工具契约，见 docs/architecture.md §4.3 与 ADR-0005。占位：仅声明契约。 */
import type { Schema } from './agent.js';
import type { RunContext } from './context.js';

/**
 * 幂等性契约，决定崩溃恢复时的行为：
 * - pure       无副作用，可自由重放
 * - idempotent 有副作用但可安全重复（SDK 注入 idempotencyKey）
 * - effectful  不可重复；模糊重放时按 onAmbiguousReplay 处理（默认 fail）
 */
export type EffectClass = 'pure' | 'idempotent' | 'effectful';

export interface RetryPolicy {
  maxAttempts: number;
  backoff: 'fixed' | 'exponential';
  initialDelayMs: number;
  retryOn?: (err: unknown) => boolean;
}

export interface ToolContext extends RunContext {
  readonly toolName: string;
  /** = stepId，供下游系统去重 */
  readonly idempotencyKey: string;
}

export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  parameters: Schema<I>;
  effect?: EffectClass;
  onAmbiguousReplay?: 'fail' | 'retry' | 'probe';
  timeoutMs?: number;
  retry?: RetryPolicy;
  /** 同 key 的工具调用串行化，用于保护外部系统 */
  concurrencyKey?: string;

  execute(input: I, ctx: ToolContext): Promise<O>;
  /** onAmbiguousReplay: 'probe' 时必需：查询该幂等键是否已生效 */
  probe?(idempotencyKey: string, ctx: ToolContext): Promise<{ applied: boolean; output?: O }>;
}

/** 工具或工具集合（MCP server、OpenAPI 文档会展开为多个 Tool） */
export type ToolRef = Tool | ToolProvider;

export interface ToolProvider {
  readonly kind: string;
  list(): Promise<Tool[]>;
  close?(): Promise<void>;
}

export interface ToolRegistry {
  register(ref: ToolRef): Promise<void>;
  get(name: string): Tool | undefined;
  list(): Tool[];
  /** 渲染为模型可见的工具描述（provider 无关） */
  describe(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}
