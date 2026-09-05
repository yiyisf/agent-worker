# Conductor AI Agent Worker SDK

把 AI Agent 作为一等公民接入 [Conductor OSS](https://conductor-oss.org/) 工作流：
工作流里放一个 task，背后就是一次完整的、可观测、可恢复、有预算约束的 Agent 运行。

- **语言**：TypeScript (Node.js ≥ 20)
- **执行模式**：Worker 内闭环 —— 一个 Conductor task = 一次完整 Agent 运行，循环跑在 **worker 进程内**
- **底座**：构建在官方 [`@io-orkes/conductor-javascript`](https://github.com/conductor-oss/javascript-sdk) 之上，不重复实现传输层
- **当前状态**：M0，架构设计与目录骨架（v0.2）。代码为契约声明，尚无实现。

## ⚠️ 先读这个：本项目是否该存在

官方 SDK 已内置完整的 **durable agent 层**（`@io-orkes/conductor-javascript/agents`）——
`Agent`/`AgentRuntime`、工具、guardrails、handoff、memory、HITL、streaming、plan-execute、
以及 LangChain / LangGraph / OpenAI Agents / Google ADK / Vercel AI 框架桥接。

它把 Agent **编译成 workflow definition 交给 Conductor 服务端执行**，本地只跑工具 worker。
本项目则把整个循环留在 **worker 进程内**。两者是不同的执行模型，不是竞品关系。

**如果官方 agents 层满足需求，就用它，不要用本项目。** 本项目只在以下至少一条成立时才有价值：

1. 模型凭据、对话上下文、工具执行必须留在自己进程内（合规 / 私有网关 / 内网工具）
2. 循环逻辑需要任意 TypeScript，无法用 agent schema 表达
3. 需要本地 MCP 或本地副作用工具（官方 `mcpTool` 由服务端连接）
4. 目标部署是纯 OSS Conductor，不便依赖服务端 agent 能力

详见 [ADR-0008](docs/adr/0008-relation-to-official-agent-layer.md)。路线图把这个判断列为 **M0.5 卡点**，
在写 M1 代码之前必须有书面结论。

## 从这里开始

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 完整技术架构设计 |
| [§1.4 定位边界](docs/architecture.md#14-与官方-agents-层的定位边界-️) | 与官方 agents 层的选型判断 |
| [§2 关键约束](docs/architecture.md#2-关键约束conductor-语义-vs-ai-agent-的天然冲突) | Conductor 语义与 Agent 现实的 7 条冲突 —— 设计的地基 |
| [docs/adr/](docs/adr/) | 8 条决策记录（含 2 条被后续推翻/修订的） |

## 设计要点速览

1. **不重复造轮子** —— 鉴权、poll 循环、并发、`extendLease` 心跳续租、`TaskContext`、worker 指标全部复用官方 SDK；`@ca/conductor` 只是薄桥接层（[ADR-0006](docs/adr/0006-build-on-official-sdk.md)）。
2. **`@ca/core` 不依赖 Conductor** —— Agent 运行时可脱离编排引擎独立运行，核心单测不需要装官方 SDK。
3. **Journaled Replay** —— 每步写 append-only journal，恢复即重放；命中 journal 的步不再调 LLM、不再调工具。at-least-once 投递下不重复付费、不重复产生副作用。
4. **三种租约策略** —— `lease-extend`（默认，心跳续租）/ `callback`（交还任务、释放槽位）/ `hybrid`（计算时占槽、等待时让位）。全部启用 Fencing Token 防并发抢占（[ADR-0007](docs/adr/0007-lease-strategies-revised.md)）。
5. **`responseTimeoutSeconds` 要设短** —— 有心跳之后它变成「崩溃检测灵敏度」，总执行上限交给 `timeoutSeconds`。设长反而让崩溃后卡满整个租约。
6. **工具幂等契约** —— `pure` / `idempotent` / `effectful`；`effectful` 在模糊重放时默认失败并交给工作流补偿分支，而不是静默重试。

## 仓库结构

```
docs/            架构设计与 ADR
packages/        core / conductor / providers-* / tools-mcp / memory / observability / testing / cli
examples/        minimal-agent (M1) / hitl-approval (M3)
```

## 路线图

M0 骨架 → **M0.5 选型验证（卡点）** → **M1** 最小可用（core + Anthropic + lease-extend 桥接）
→ **M2** 可靠性（journal / fencing / callback / hybrid）→ **M3** 生态（本地 MCP / 子工作流工具 / HITL）
→ **M4** 生产化（OTel / 预算 / 多租户）→ **M5** 白盒模式（可选）

详见 [docs/architecture.md §14](docs/architecture.md#14-路线图)。
