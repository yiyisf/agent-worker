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
  /**
   * 引擎代码在哪运行。interceptTools 由它机械推导，不必逐个适配器人工核实：
   *   interceptTools = (runtimeLocation === 'host-process')
   * AI SDK harness 适配器的运行位置见 architecture.md §4.4 的能力表。
   */
  runtimeLocation: 'host-process' | 'sandbox';
  /** 跨分片状态如何保存 */
  state: 'messages' | 'snapshot' | 'engine-session' | 'replay';
  /**
   * 挂起机制（§4.7）。v0.5 删除了 replay-signal（ADR-0014）：
   * 在别人的代码里抛异常炸开调用栈不可控，而 9 个 harness 适配器里 8 个都有原生审批。
   * 'none' 的引擎不支持 HITL —— spec 声明 approval 时**启动即拒绝**，不留到运行期。
   */
  suspend: 'native-approval' | 'none';
  /**
   * 分片边界控制（ADR-0015）：
   * 'native' 引擎能接受 SliceBudget 并翻译成原生停止条件（AI SDK 用 stopWhen）
   * 'none'   引擎的一轮不可中途拆分（如 harness 的一个 turn）→ 一轮 = 一分片
   */
  sliceControl: 'native' | 'none';
  /** 能否拦截模型调用 —— 决定 journal 能否覆盖 LLM 成本。false 则拒绝启动 */
  interceptModel: boolean;
  /** 能否拦截工具执行 —— 决定幂等与副作用保护是否有效。
   *  false（sandbox 内执行工具）则拒绝声明 effectful 策略的 spec */
  interceptTools: boolean;
  /** journal 与恢复的粒度 */
  granularity: 'step' | 'turn';
  streaming: boolean;
  structuredOutput: boolean;
}

/**
 * 本分片的预算。core 给预算、引擎翻译成原生停止条件（ADR-0015）。
 * 不由 core 强行打断 —— 打断别人的循环拿不到干净、可续跑的状态。
 * sliceControl: 'none' 的引擎仅把它当作超限告警依据，不强制。
 */
export interface SliceBudget {
  /** 墙钟预算，默认 limits.sliceMs（60s） */
  wallClockMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
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
    /** 本分片预算，由引擎翻译成原生停止条件（ADR-0015） */
    budget: SliceBudget;
    ctx: RunContext;
  }): Promise<EngineTurn<TState>>;
}

export interface AgentEngine<TState = JsonValue> {
  readonly id: string;
  /**
   * 引擎暴露给领域包的契约版本（ADR-0017）。只在 Pack 可见的形状破坏性变化时 +1；
   * 与上游 SDK 的版本号无关 —— 上游升级只要没动我们依赖的 3 个 API 面，此值不变。
   */
  readonly contractVersion: number;
  readonly capabilities: EngineCapabilities;
  /** 由 spec 构建可复用的引擎实例（进程级，跨 run 复用） */
  build(spec: AgentSpec, deps: EngineDeps): Promise<BuiltAgent<TState>>;
}

/**
 * 能力—配置一致性校验；不满足则拒绝启动或显式降级并告警（§4.4）。
 *
 *   interceptModel: false                        → 拒绝启动（journal 形同虚设）
 *   interceptTools: false + spec 有 effectful 工具 → 拒绝启动（幂等保护不存在）
 *   interceptTools: false + 工具均为 pure         → 允许，journal 退化到 turn 级
 *   suspend: 'none' + spec 声明 approval          → 拒绝启动（不能跑到一半才发现停不下来）
 *   sliceControl: 'none'                          → 允许，一轮 = 一分片
 */
export declare function assertCapabilities(spec: AgentSpec, caps: EngineCapabilities): void;
