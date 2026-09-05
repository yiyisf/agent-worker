/**
 * AgentSpec —— 纯 JSON 数据的 Agent 描述，见 docs/architecture.md §4.1 与 ADR-0013。
 * 占位：仅声明契约。
 *
 * 设计要点：**分离数据与实现**。spec 里没有函数字段，因此可来自 TS / JSON / YAML / 远程配置，
 * 可 diff、可审计、可灰度。实现（工具、护栏、prompt 正文）由代码提供，spec 只放引用。
 */

export type JsonValue =
  | null | boolean | number | string
  | JsonValue[]
  | { [k: string]: JsonValue };

/** 工具的**可靠性策略**（不是工具实现 —— 实现用引擎的原生写法，见 §4.6） */
export interface ToolPolicy {
  /** 幂等契约，决定崩溃恢复时的行为（ADR-0005） */
  effect: 'pure' | 'idempotent' | 'effectful';
  onAmbiguousReplay?: 'fail' | 'retry' | 'probe';
  timeoutMs?: number;
  concurrencyKey?: string;
  /** 需要人工审批 —— 映射到引擎原生审批或 replay-signal（§4.7） */
  approval?: 'never' | 'always' | 'policy';
  /** 返回值是否标记为不可信（提示注入防护，§9） */
  trust?: 'trusted' | 'untrusted';
}

export interface AgentLimits {
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  /** 单次运行墙钟上限；推导 TaskDef.timeoutSeconds（必须覆盖所有分片执行 + 所有等待） */
  wallClockMs?: number;
  /** 单个 callback 分片的目标时长，默认 60_000 */
  sliceMs?: number;
}

/** 见 ADR-0007 / ADR-0009。默认 callback */
export type LeaseStrategy = 'callback' | 'lease-extend' | 'hybrid';
export type ResumePolicy = 'on-lease-loss' | 'fresh-per-retry' | 'never';

export interface ConductorTaskOptions {
  taskType: string;
  domain?: string;
  leaseStrategy: LeaseStrategy;
  resumePolicy: ResumePolicy;
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

/** 三层合并后的最终配置，写入 journal 与 outputData 以便追溯（§7.2） */
export interface EffectiveSpec extends AgentSpec {
  readonly resolvedFrom: Array<{ layer: 'L0' | 'L1' | 'L2'; source: string }>;
  readonly hash: string;
}
