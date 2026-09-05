/**
 * AgentEngine —— 适配外部 Agent SDK 的契约，见 docs/architecture.md §4.2 与 ADR-0011。
 * 占位：仅声明契约。
 *
 * 契约刻意只有 3 个成员（capabilities / build / run），目标是「任何 Agent SDK 都能在几十行内适配」。
 * 引擎的唯一硬性义务：所有模型调用经 deps.model、所有工具执行经 deps.tools（ADR-0012）。
 */
import type { AgentSpec, JsonValue } from './spec.js';
import type { RunContext, Logger } from './context.js';
import type { ManagedModelGateway, ManagedToolGateway } from './gateway.js';

/**
 * 引擎能力声明。不同引擎能力差异很大，core 显式建模而非假装统一（§4.4）。
 * ⚠️ 谎报能力会让用户误以为拿到了 effectively-once —— @ca/testing 的一致性套件专门验证这一点。
 */
export interface EngineCapabilities {
  /** 跨分片状态如何保存 */
  state: 'messages' | 'snapshot' | 'engine-session' | 'replay';
  /** 挂起机制（§4.7） */
  suspend: 'native-approval' | 'replay-signal' | 'none';
  /** 能否拦截模型调用 —— 决定 journal 能否覆盖 LLM 成本。false 则拒绝启动 */
  interceptModel: boolean;
  /** 能否拦截工具执行 —— 决定幂等与副作用保护是否有效。
   *  false（如 sandbox 内执行工具的 harness）则拒绝声明 effectful 策略的 spec */
  interceptTools: boolean;
  /** journal 与恢复的粒度 */
  granularity: 'step' | 'turn';
  streaming: boolean;
  structuredOutput: boolean;
}

/** 等待外部信号时的描述，供审批系统与恢复逻辑使用 */
export interface AwaitingSpec {
  kind: 'approval' | 'workflow' | 'external';
  /** 引擎侧标识，如 AI SDK 的 approvalId、子工作流 id */
  ref: string;
  toolName?: string;
  input?: JsonValue;
  /** 建议的 callbackAfterSeconds；桥接层会按 timeoutSeconds 预算校验 */
  suggestedCallbackAfterSeconds?: number;
}

export type EngineTurn<TState = JsonValue> =
  /** 整体完成 */
  | { kind: 'done'; output: JsonValue; state?: TState }
  /** 本轮做完但未完成（分片预算到了），下一分片继续 */
  | { kind: 'continue'; state: TState }
  /** 等待外部信号 */
  | { kind: 'suspended'; state: TState; awaiting: AwaitingSpec };

export interface EngineDeps {
  /** 受管模型入口。引擎注入到自己的 provider 位置（AI SDK 用 wrapLanguageModel） */
  model: ManagedModelGateway;
  /** 受管工具入口。引擎用它包装每个工具的 execute */
  tools: ManagedToolGateway;
  logger: Logger;
}

export interface BuiltAgent<TState = JsonValue> {
  /** 跑一轮。一轮 = 一个 Conductor 分片能完成的工作量 */
  run(args: {
    input: JsonValue;
    /** 上一分片交还的状态；首片为 undefined */
    state?: TState;
    ctx: RunContext;
  }): Promise<EngineTurn<TState>>;
}

export interface AgentEngine<TState = JsonValue> {
  readonly id: string;
  readonly capabilities: EngineCapabilities;
  /** 由 spec 构建可复用的引擎实例（进程级，跨 run 复用） */
  build(spec: AgentSpec, deps: EngineDeps): Promise<BuiltAgent<TState>>;
}

/** 能力—配置一致性校验；不满足则拒绝启动或显式降级并告警（§4.4） */
export declare function assertCapabilities(spec: AgentSpec, caps: EngineCapabilities): void;
