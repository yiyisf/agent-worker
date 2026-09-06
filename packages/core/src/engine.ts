/**
 * AgentEngine —— 适配外部 Agent SDK 的契约，见 docs/architecture.md §4.2 与 ADR-0011。
 *
 * 契约刻意只有 3 个成员（capabilities / build / run），目标是「任何 Agent SDK 都能在几十行内适配」。
 * 引擎的唯一硬性义务：所有模型调用经 gateways.model、所有工具执行经 gateways.tools（ADR-0012）。
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
   * 成本可见性：
   * 'per-call' 每次模型调用都经过受管入口 → journal 可短路、预算可在调用**前**拦截
   * 'per-turn' 拦不到单次调用，但每轮结束有 usage → 事后记账 + 轮间预算闸门。
   *            AI SDK 的 HarnessAgent 全部属于此类：它的 model 是 harness 专属字符串，
   *            不存在可供 wrapLanguageModel 包装的模型对象（与沙箱无关）
   * 'none'     完全无成本可见性 → 拒绝启动
   */
  costVisibility: 'per-call' | 'per-turn' | 'none';
  /**
   * 工具拦截范围：
   * 'all'                所有工具都经过受管入口
   * 'host-declared-only' 只有我们声明的工具拦得到；引擎自带的内建工具拦不到 →
   *                      effectful 只能声明在 host-declared 工具上，否则启动即拒绝
   * 'none'               一个都拦不到 → 拒绝任何 effectful 策略
   */
  toolInterception: 'all' | 'host-declared-only' | 'none';
  /** 跨分片状态如何保存。'engine-session' 表示避免重复付费由引擎的 session resume 负责，不是我们的 journal */
  state: 'messages' | 'snapshot' | 'engine-session' | 'replay';
  /**
   * 挂起机制（§4.7）。v0.5 删除了 replay-signal（ADR-0014）。
   * 'none' 的引擎不支持 HITL —— spec 声明 approval 时**启动即拒绝**，不留到运行期。
   */
  suspend: 'native-approval' | 'none';
  /**
   * 分片边界控制（ADR-0015）：
   * 'native' 引擎能接受 SliceBudget 并翻译成原生停止条件（AI SDK 用 stopWhen）
   * 'none'   引擎的一轮不可中途拆分（如 harness 的一个 turn）→ 一轮 = 一分片
   */
  sliceControl: 'native' | 'none';
  /** journal 与恢复的粒度 */
  granularity: 'step' | 'turn';
  /** 进展反馈能到什么粒度（§10.4 / ADR-0018） */
  progress: 'step' | 'turn' | 'none';
  streaming: boolean;
  structuredOutput: boolean;
}

/**
 * 本分片的预算。core 给预算、引擎翻译成原生停止条件（ADR-0015）。
 * 不由 core 强行打断 —— 打断别人的循环拿不到干净、可续跑的状态。
 * sliceControl='none' 的引擎仅把它当作超限告警依据，不强制。
 */
export interface SliceBudget {
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

/** 构建期依赖（进程级） */
export interface EngineBuildDeps {
  logger: Logger;
}

/** 运行期受管入口（每次 run 独立 —— 它们承载该 run 的 journal 状态） */
export interface RunGateways {
  model: ManagedModelGateway;
  tools: ManagedToolGateway;
}

export interface EngineRunArgs<TState = JsonValue> {
  input: JsonValue;
  /** 上一分片交还的状态；首片为 undefined */
  state?: TState;
  /** 恢复时回灌的外部结果（如审批决定） */
  resumeWith?: JsonValue;
  /** 本分片预算，由引擎翻译成原生停止条件（ADR-0015） */
  budget: SliceBudget;
  ctx: RunContext;
  gateways: RunGateways;
}

export interface BuiltAgent<TState = JsonValue> {
  /** 跑一轮。一轮 = 一个 Conductor 分片能完成的工作量 */
  run(args: EngineRunArgs<TState>): Promise<EngineTurn<TState>>;
}

export interface AgentEngine<TState = JsonValue> {
  readonly id: string;
  /**
   * 引擎暴露给领域包的契约版本（ADR-0017）。只在 Pack 可见的形状破坏性变化时 +1；
   * 与上游 SDK 的版本号无关 —— 上游升级只要没动我们依赖的 3 个 API 面，此值不变。
   */
  readonly contractVersion: number;
  readonly capabilities: EngineCapabilities;
  /** 引擎自带的内建工具名，供 §4.4 的 host-declared-only 规则校验 */
  readonly builtinTools?: readonly string[];
  /** 由 spec 构建可复用的引擎实例（进程级，跨 run 复用） */
  build(spec: AgentSpec, deps: EngineBuildDeps): Promise<BuiltAgent<TState>>;
}
