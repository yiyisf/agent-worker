/**
 * SpecLoader 与领域包，见 docs/architecture.md §7 与 ADR-0013。占位：仅声明契约。
 *
 * 合并顺序 L0 → L1（按 extends 顺序）→ L2，后者覆盖前者；
 * 数组字段的合并策略显式声明（guardrails 追加、toolPolicies 按键覆盖）。
 * 合并结果输出 EffectiveSpec 快照，写入 journal 与 outputData —— 配置化系统的生命线。
 */
import type { AgentSpec, EffectiveSpec, ToolPolicy } from './spec.js';
import type { Guardrail } from './guardrail.js';

/**
 * 领域包（L1）。可贡献：工具、工具策略、护栏、prompt、spec 片段、eval 数据集、领域 schema。
 * **不可**贡献：受管入口的实现、Journal / Fence 语义、Conductor 映射 —— 那些是 core 的不变量。
 *
 * ⚠️ Pack 与引擎适配器同进程运行、具备完整权限，应按依赖审计对待（§9）。
 */
export interface DomainPack {
  name: string;
  version: string;
  /** 工具用引擎原生格式定义（如 AI SDK 的 tool()），core 不解释 */
  tools?: Record<string, unknown>;
  toolPolicies?: Record<string, ToolPolicy>;
  guardrails?: Guardrail[];
  prompts?: Record<string, string>;
  specs?: Record<string, Partial<AgentSpec>>;
  /** eval 数据集路径，供 ca eval 使用 */
  evals?: string;
  /**
   * **必填**：兼容的引擎与其**契约版本**范围，如 { 'ai-sdk/tool-loop': '^1' }（ADR-0017）。
   * 声明的是我们自己维护的 AgentEngine.contractVersion，不是上游 SDK 的版本号 ——
   * 上游升级只要没动适配器依赖的 3 个 API 面，契约版本不变，Pack 无需跟随。
   * 不声明则 SpecLoader 拒绝加载，不给"忘了写"留余地。
   */
  engines: Record<string, string>;
}

export declare function definePack(pack: DomainPack): DomainPack;

export interface SpecLoader {
  /** 解析 extends、三层合并、JSON Schema 校验，返回可追溯的有效配置 */
  resolve(spec: AgentSpec): Promise<EffectiveSpec>;
  /** ca spec diff */
  diff(a: EffectiveSpec, b: EffectiveSpec): Array<{ path: string; from: unknown; to: unknown }>;
  /** ca spec explain <field>：说明某字段来自哪一层 */
  explain(spec: EffectiveSpec, path: string): { layer: 'L0' | 'L1' | 'L2'; source: string; value: unknown };
}
