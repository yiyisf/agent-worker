/**
 * AgentEngine —— 适配外部 Agent SDK 的契约，见 docs/architecture.md §4.2 与 ADR-0011。
 *
 * 契约刻意只有 3 个成员（capabilities / build / run），目标是「任何 Agent SDK 都能在几十行内适配」。
 * 引擎的唯一硬性义务：所有模型调用经 gateways.model、所有工具执行经 gateways.tools（ADR-0012）。
 *
 * ⚠️ 一次 run 从头跑到完成（ADR-0019 / ADR-0022）。没有跨调用的状态交接 ——
 * agent 的状态自始至终在这一次 run 的内存里，extendLease 心跳保证它不会中途换 worker。
 * 短等待（慢接口）由工具在 run 内部 await；长等待（人工审批）交给工作流（§4.7）。
 */
import type { AgentSpec, JsonValue } from './spec.js';
import type { RunContext, Logger } from './context.js';
import type { ManagedModelGateway, ManagedToolGateway } from './gateway.js';

/**
 * 引擎能力声明。不同引擎能力差异很大，core 显式建模而非假装统一（§4.4）。
 * ⚠️ 谎报能力会让用户误以为拿到了成本管控与副作用保护 —— @ca/testing 的一致性套件专门验证这一点。
 */
export interface EngineCapabilities {
  /**
   * 成本可见性：
   * 'per-call' 每次模型调用都经过受管入口 → 预算可在调用**前**拦截
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
  /**
   * 是否支持在运行内部完成人工审批的两段式等待（§4.7）。
   * 'none' 的引擎不支持 HITL —— spec 声明 approval 时**启动即拒绝**。
   */
  suspend: 'native-approval' | 'none';
  /** 进展反馈能到什么粒度（§10.4 / ADR-0018） */
  progress: 'step' | 'turn' | 'none';
  streaming: boolean;
  structuredOutput: boolean;
}

/**
 * 本次运行的预算。core 给预算、引擎翻译成原生停止条件。
 * 不由 core 强行打断引擎循环 —— 打断别人的循环拿不到干净的状态。
 * 真正的硬闸门在受管入口上（超了就在下一次调用前抛 BudgetExceededError）。
 */
export interface RunBudget {
  wallClockMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
}

/** 构建期依赖（进程级） */
export interface EngineBuildDeps {
  logger: Logger;
}

/** 运行期受管入口（每次 run 独立） */
export interface RunGateways {
  model: ManagedModelGateway;
  tools: ManagedToolGateway;
}

export interface EngineRunArgs {
  input: JsonValue;
  /**
   * 上一次 attempt 的 outputData（Conductor 在重试时原生携带，见 §2.2）。
   * 首次执行为 undefined。agent 可据此决定「接着上次做」还是「重头来」——
   * 这是**业务判断**，不是恢复机制。
   */
  previousAttempt?: JsonValue;
  budget: RunBudget;
  ctx: RunContext;
  gateways: RunGateways;
}

export interface BuiltAgent {
  /** 从头跑到完成。返回最终输出；失败就抛（CaError.retryable 决定是否可重试） */
  run(args: EngineRunArgs): Promise<JsonValue>;
}

export interface AgentEngine {
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
  build(spec: AgentSpec, deps: EngineBuildDeps): Promise<BuiltAgent>;
}
