/**
 * AgentSpec —— 纯 JSON 数据的 Agent 描述，见 docs/architecture.md §4.1 与 ADR-0013。
 *
 * 设计要点：**分离数据与实现**。spec 里没有函数字段，因此可来自 TS / JSON / YAML / 远程配置，
 * 可 diff、可审计、可灰度。实现（工具、护栏、prompt 正文）由代码提供，spec 只放引用。
 */

export type JsonValue =
  | null | boolean | number | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export type JsonObject = { [k: string]: JsonValue };

/** 工具的**可靠性策略**（不是工具实现 —— 实现用引擎的原生写法，见 §4.6） */
export interface ToolPolicy {
  /**
   * 幂等契约。受管工具入口据此决定超时后是否可以安全重试，
   * 并把 idempotencyKey 传给工具实现（ADR-0005）。
   */
  effect: 'pure' | 'idempotent' | 'effectful';
  /** 单次工具执行超时；缺省取 limits.toolCallTimeoutMs */
  timeoutMs?: number;
  concurrencyKey?: string;
  /** 需要人工审批 —— 由引擎的原生两段式审批在**运行内部**完成等待（§4.7）。
   *  引擎 capabilities.suspend === 'none' 时，声明本字段会导致**启动即拒绝** */
  approval?: 'never' | 'always' | 'policy';
  /** 返回值是否标记为不可信（提示注入防护，§9） */
  trust?: 'trusted' | 'untrusted';
}

/**
 * 限额全部是 **worker 自己**的关注面（§2.3）。
 * 编排任务的超时、重试、调度由 Conductor 按 TaskDef 处理，worker 一个字都不读。
 */
export interface AgentLimits {
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  /** 单次 agent 运行的墙钟上限，超时即判失败。默认 1800_000（30 分钟） */
  wallClockMs?: number;
  /** 单次模型调用超时，默认 120_000 */
  modelCallTimeoutMs?: number;
  /** 单次工具执行超时，默认 60_000 */
  toolCallTimeoutMs?: number;
}

/** 后台运行的宿主进程没了（崩溃 / 重启）时怎么办，见 ADR-0021 */
export type OrphanPolicy =
  /** 由下一个接到 callback 的 worker 重新发起整个运行；**不消耗 Conductor 重试配额** */
  | 'restart'
  /** 判失败交回引擎，由 TaskDef.retryCount 决定是否重试 */
  | 'fail';

export interface ConductorTaskOptions {
  taskType: string;
  domain?: string;
  /** 每次交还任务时请求的回调间隔（秒）。这是**心跳节奏**，与任何引擎超时无关，默认 30 */
  callbackAfterSeconds: number;
  /** 运行心跳多久没更新就认定宿主已死，默认 90_000（≥ 3 × callbackAfterSeconds） */
  orphanAfterMs: number;
  onOrphan: OrphanPolicy;
  payloadStrategy: 'externalize' | 'truncate' | 'fail';
  maxOutputBytes: number;
}

export interface AgentSpec {
  name: string;
  version?: number;

  /** 引擎标识，如 'ai-sdk/tool-loop' | 'ai-sdk/harness' | 自定义注册名 */
  engine: string;
  /**
   * 透传给引擎的原生配置，对 core **不透明**。
   * 刻意不统一各引擎的配置形状 —— 统一它们等于重新发明每个 SDK（ADR-0013）。
   */
  engineOptions?: JsonValue;

  toolPolicies?: Record<string, ToolPolicy>;
  limits?: AgentLimits;
  /** 护栏引用（实现由代码/领域包提供） */
  guardrails?: string[];
  conductor?: Partial<ConductorTaskOptions>;

  /** 领域包与预设的引用，由 SpecLoader 按顺序合并（L1） */
  extends?: string[];
}

/** 三层合并后的最终配置，随结果写进 outputData 以便追溯（§7.2） */
export interface EffectiveSpec extends AgentSpec {
  readonly resolvedFrom: Array<{ layer: 'L0' | 'L1' | 'L2'; source: string }>;
  readonly hash: string;
}

export const DEFAULT_WALL_CLOCK_MS = 1_800_000;
export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 120_000;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_CALLBACK_AFTER_SECONDS = 30;
export const DEFAULT_ORPHAN_AFTER_MS = 90_000;
