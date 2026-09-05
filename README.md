# Conductor AI Agent Worker SDK

面向 [Conductor OSS](https://conductor-oss.org/) 的**通用、可扩展**AI Agent worker SDK：
工作流里放一个 task，背后就是一次完整的、可观测、可恢复、有预算约束的 Agent 运行。

- **语言**：TypeScript (Node.js ≥ 20)
- **执行模式**：Worker 内闭环 —— 一个 Conductor task = 一次完整 Agent 运行，循环跑在 **worker 进程内**
- **默认租约**：`callback` 分片执行（Conductor 3.x 全系可用）
- **底座**：构建在官方 [`@io-orkes/conductor-javascript`](https://github.com/conductor-oss/javascript-sdk) 之上，不重复实现传输层
- **当前状态**：M0，架构设计与目录骨架（v0.3）。代码为契约声明，尚无实现。

## 设计要点

### 1. 通用 + 可扩展：三层扩展面

推理循环本身是扩展点，不绑定单一 Agent 范式（[ADR-0010](docs/adr/0010-pluggable-agent-strategy.md)）：

| 层 | 扩展点 | 介入深度 |
|---|---|---|
| **L1** 替换实现 | `ModelProvider` / `ToolProvider` / `StateStore` / `BlobStore` / `MemoryStore` / `SecretProvider` / `EventSink` | 换后端，不改行为 |
| **L2** 改变行为 | `Guardrail` / `ContextPolicy` / `ToolSelector` / `OutputParser` / `ErrorClassifier` / `BudgetPolicy` / `PromptSource` | 介入循环，不重写循环 |
| **L3** 替换循环 | `AgentStrategy` —— 内置 `react` / `plan-execute` / `reflect` / `single-shot` / `router`，可注册自定义 | 换范式 |

外加**场景 Profile**（打包 策略+限额+护栏+租约）与 `@ca/plugin-*` 插件约定。

**关键设计：策略只做决策，不做执行。** 策略返回 `StepPlan`（意图），由 Runtime 去执行、写 journal、
做幂等、扣预算、跑护栏、记 span。因此**任何自定义策略都零成本继承全部可靠性机制**——
这是本 SDK 相对「自己写个 while 循环」的核心价值。

### 2. Journaled Replay

每步写 append-only journal，恢复即重放；命中 journal 的步不再调 LLM、不再调工具。
at-least-once 投递下不重复付费、不重复产生副作用。配合 Fencing Token 达到实际意义上的 effectively-once。

### 3. 默认 `callback` 分片执行

`callback` 让「持久化 journal → 换个进程继续」变成**每次运行都走的主路径**，
而不是只在崩溃时才跑的旁路——只在故障时才执行的代码就是不可靠的代码
（[ADR-0009](docs/adr/0009-default-callback-strategy.md)）。
`lease-extend`（心跳续租）作为可选优化保留，要求 Conductor ≥ v3.10.7。

### 4. 不重复造轮子

鉴权、poll 循环、并发、`extendLease` 心跳、`TaskContext`、worker 指标全部复用官方 SDK；
`@ca/conductor` 只是薄桥接层（[ADR-0006](docs/adr/0006-build-on-official-sdk.md)）。
`@ca/core` 不依赖 Conductor，核心单测不需要装官方 SDK。

## Conductor 版本要求

| 能力 | 最低版本 | 依据 |
|---|---|---|
| `callback` 策略（默认） | 3.x 全系 | `callbackAfterSeconds` 一直存在 |
| `lease-extend` / `hybrid` | **v3.10.7** | `TaskResult.extendLease` 字段与服务端处理逻辑自该版本引入（v3.10.6 无） |

服务端租约/超时的精确语义（源码级核实）见 [architecture.md §2.2](docs/architecture.md#22-服务端语义核实依据-conductor-oss-v32121-源码)，
其中三条容易踩的坑：`retryCount` 不可为 0、`timeoutSeconds` 必须覆盖所有等待时间、`timeoutPolicy` 对 responseTimeout 无效。

## 从这里开始

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 完整技术架构设计 |
| [§2 关键约束](docs/architecture.md#2-关键约束conductor-语义-vs-ai-agent-的天然冲突) | Conductor 语义与 Agent 现实的 7 条冲突 + 服务端语义核实 |
| [§4.3 扩展架构](docs/architecture.md#43-扩展架构--三层扩展面) | 三层扩展面、AgentStrategy、Profile、插件 |
| [docs/adr/](docs/adr/) | 10 条决策记录（含 2 条被后续推翻/修订的） |

## 仓库结构

```
docs/            架构设计与 ADR
packages/        core / conductor / providers-* / tools-mcp / memory / observability / testing / cli
examples/        minimal-agent (M1) / hitl-approval (M4)
```

## 路线图

**M1** 最小可用（Runtime + react + journal + callback + Anthropic，跑通 3.21.21）
→ **M2** 可靠性（fencing / 三类测试 / lease-extend + 版本探测）
→ **M3** 扩展面（AgentStrategy 公开 + 5 内置策略 + L2 扩展点 + Profile + 插件）
→ **M4** 生态（本地 MCP / 子工作流工具 / HITL）
→ **M5** 生产化（OTel / 预算 / 多租户）
→ **M6** 白盒模式（可选）

详见 [architecture.md §14](docs/architecture.md#14-路线图)。
