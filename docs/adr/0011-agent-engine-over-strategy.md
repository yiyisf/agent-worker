# ADR-0011：以 `AgentEngine` 适配现成 SDK，取代自研 `AgentStrategy`

- 状态：Accepted（Supersedes [ADR-0010](0010-pluggable-agent-strategy.md)）
- 日期：2026-09-05

## 背景

ADR-0010 设计了 `AgentStrategy`：由本项目定义循环范式契约，并内置
`react` / `plan-execute` / `reflect` / `single-shot` / `router` 五种实现。

核查 Vercel AI SDK 后发现，这五种范式它已经全部覆盖，且覆盖得更好：

| 我们打算自建 | AI SDK 已有 |
|---|---|
| `react` 循环 | `ToolLoopAgent`（默认 `isStepCount(20)`） |
| 停止条件 | `stopWhen` + `isStepCount` / `hasToolCall` / `isLoopFinished` / 自定义谓词 |
| 上下文压缩（`ContextPolicy`） | `prepareStep` 返回新的 `messages` + `pruneMessages` 助手 |
| 工具收窄（`ToolSelector`） | `prepareStep` 的 `activeTools` |
| 动态模型选择 | `prepareStep` 返回 `model` |
| 结构化输出与修复 | `Output` / `experimental_output` |
| `plan-execute` / 子 agent | workflow patterns、subagents |
| HITL | `toolApproval` 的两段式审批 |
| 模型 provider 生态 | 全部主流 provider |
| MCP | `@ai-sdk/mcp`（`createMCPClient` + stdio / Streamable HTTP） |
| 接入既有 harness | `HarnessAgent` + Claude Code / Cline / Codex / Cursor / Deep Agents / fx / Grok Build / OpenCode / Pi 适配器 |

## 决策

取消自研 `AgentStrategy` 与五个内置策略。改为定义 `AgentEngine` 契约（3 个成员：
`capabilities` / `build` / `run`），把循环整体委派给外部 Agent SDK。

首个实现 `@ca/engine-ai-sdk` 适配 AI SDK `ToolLoopAgent`；
`@ca/engine-harness` 适配 `HarnessAgent`（从而一次拿到 9+ 个既有 harness）；
`@ca/engine-custom` 提供最小手写循环，兼作契约参考实现与一致性测试基线。

同时删除 `@ca/providers-anthropic`、`@ca/providers-openai`、`@ca/tools-mcp` 三个包。

## 理由

1. **同一个错误不该犯第三次**。ADR-0002（自研 Conductor 客户端）与 ADR-0004（错判心跳能力）
   都源于「先自建、后发现生态已有」。ADR-0010 是同一模式的第三次：自建循环范式，
   而 AI SDK 已经把这块做到了更成熟的程度。
2. **通用性来自适配面，不来自我们的抽象**。用户要的"支持多 SDK / 组件模式"，
   靠自建第六种范式实现不了；靠一个 3 成员的适配契约才实现得了。
3. **`EngineTurn` 与 Conductor 分片天然同构**。引擎交还一轮 = 桥接层交还一个分片，
   AI SDK 的两段式审批正好落在这个边界上，不需要任何 hack。
4. **核心价值转移到别处**。本 SDK 不可替代的是「Conductor 编排下的可靠性」——
   Journal、幂等、Fencing、租约、预算、能力校验。这些恰恰是 Agent SDK 不做的
   （AI SDK 的持久化留给了 Workflow DevKit 一类外部方案，而我们的编排层是 Conductor）。

## 代价

- **依赖外部 SDK 的演进节奏**。AI SDK 迭代很快。
  → `@ca/core` 不依赖任何 Agent SDK，冲击被隔离在适配器包内；适配器声明支持的版本范围并进 CI 矩阵。
- **失去对循环细节的控制**，如无法在任意点插入自定义逻辑。
  → 这正是分层的取舍；确需完全控制的用户写 `@ca/engine-custom` 风格的自定义引擎，
  同样通过受管入口获得全部可靠性能力。
- **能力参差**。不同引擎能力差异大。→ [ADR-0012](0012-reliability-by-interception.md) 的
  `EngineCapabilities` 显式建模 + 启动时校验。
