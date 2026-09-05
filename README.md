# Conductor AI Agent Worker SDK

把 AI Agent 作为一等公民接入 [Conductor OSS](https://conductor-oss.org/) 工作流：
工作流里放一个 task，背后就是一次完整的、可观测、可恢复、有预算约束的 Agent 运行。

- **语言**：TypeScript (Node.js ≥ 20)
- **执行模式**：Worker 内闭环 —— 一个 Conductor task = 一次完整 Agent 运行（ReAct / tool-calling 循环在 worker 进程内完成）
- **当前状态**：M0，架构设计与目录骨架。代码为契约声明，尚无实现。

## 从这里开始

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 完整技术架构设计 |
| [§2 关键约束](docs/architecture.md#2-关键约束conductor-语义-vs-ai-agent-的天然冲突) | Conductor 语义与 Agent 现实的 7 条冲突 —— 整个设计的地基 |
| [docs/adr/](docs/adr/) | 5 条关键决策记录 |

## 设计要点速览

1. **`@ca/core` 不依赖 `@ca/conductor`** —— Agent 运行时可脱离编排引擎独立运行，Conductor 只是宿主之一。
2. **Journaled Replay** —— 每一步写 append-only journal，恢复即重放；命中 journal 的步不再调 LLM、不再调工具。at-least-once 投递下不重复付费、不重复产生副作用。
3. **双租约策略** —— `long-lease`（短 Agent，由 limits 反推 TaskDef 超时）与 `yield`（长 Agent / 人工审批 / 等子工作流，主动交还任务释放槽位），两者都用 Fencing Token 防并发抢占。
4. **工具幂等契约** —— `pure` / `idempotent` / `effectful`；`effectful` 在模糊重放时默认失败并交给工作流补偿分支，而不是静默重试。
5. **黑盒里的编排出口** —— `conductorWorkflowTool` 让 Agent 把重活交回 Conductor 工作流；`StepExecutor` 接口为未来的白盒模式留口。

## 仓库结构

```
docs/            架构设计与 ADR
packages/        core / conductor / providers-* / tools-mcp / memory / observability / testing / cli
examples/        minimal-agent (M1) / hitl-approval (M3)
```

## 路线图

M0 骨架 → **M1** 最小可用（core + Anthropic + long-lease，端到端跑通）→ **M2** 可靠性（journal / fencing / yield）
→ **M3** 生态（MCP / 子工作流工具 / HITL）→ **M4** 生产化（OTel / 预算 / 多租户）→ **M5** 白盒模式（可选）

详见 [docs/architecture.md §14](docs/architecture.md#14-路线图)。
