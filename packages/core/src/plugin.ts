/**
 * 插件打包与发现，见 docs/architecture.md §4.3。占位：仅声明契约。
 *
 * 命名约定：`@ca/plugin-*` 或 `<scope>/ca-plugin-*`；`ca plugins list` 查看已装插件与其贡献的扩展点。
 *
 * ⚠️ 信任边界：插件运行在同一进程，具备完整权限，应按依赖审计对待（§11）。
 */
import type { AgentStrategy, AgentProfile } from './strategy.js';
import type { Guardrail } from './guardrail.js';
import type { ModelProvider } from './model.js';
import type { ToolRef } from './tool.js';

export interface AgentPlugin {
  name: string;
  version: string;
  strategies?: AgentStrategy[];
  providers?: ModelProvider[];
  tools?: ToolRef[];
  guardrails?: Guardrail[];
  profiles?: AgentProfile[];
}

export declare function definePlugin(plugin: AgentPlugin): AgentPlugin;
