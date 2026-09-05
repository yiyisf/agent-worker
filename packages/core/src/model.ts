/** 模型抽象，见 docs/architecture.md §4.4 与 §8。占位：仅声明契约。 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type Part =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; mediaType: string; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; output: unknown; isError?: boolean };

export interface Message {
  role: Role;
  content: Part[];
  /** 工具返回与外部检索内容标记为不可信，供护栏识别（§11） */
  trust?: 'trusted' | 'untrusted';
}

export interface ModelRef {
  /** 例如 'claude-opus-5'、'claude-sonnet-5' */
  id: string;
  provider?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** 透传 provider 的 prompt cache 提示 */
  cache?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface ModelRequest {
  model: ModelRef;
  system?: string;
  messages: Message[];
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  responseSchema?: Record<string, unknown>;
}

export type StopReason = 'stop' | 'tool_use' | 'max_tokens' | 'content_filter' | 'other';

export interface ModelResponse {
  message: Message;
  stopReason: StopReason;
  usage: Usage;
}

export type ModelDelta =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; partialInput: string }
  | { type: 'done'; response: ModelResponse };

export interface ModelCallContext {
  signal: AbortSignal;
  /** = stepId，用于响应缓存与重放 */
  stepId: string;
  tenantId?: string;
}

export interface ModelProvider {
  readonly id: string;
  generate(req: ModelRequest, ctx: ModelCallContext): Promise<ModelResponse>;
  stream?(req: ModelRequest, ctx: ModelCallContext): AsyncIterable<ModelDelta>;
  countTokens?(req: ModelRequest): Promise<number>;
}

/** 主备切换、按错误类别退避、per-model 限流，见 §8 */
export interface ModelRouter extends ModelProvider {
  readonly chain: ModelRef[];
}
