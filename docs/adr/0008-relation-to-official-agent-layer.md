# ADR-0008：与官方 agents 层的定位边界

- 状态：**Resolved（2026-09-05）：不采用官方 agents 层，本项目继续**
- 日期：2026-09-05

## 背景

`@io-orkes/conductor-javascript`（实际发布版 4.0.0）内置了完整的 **durable agent 层**（`/agents` 子路径导出）：
`Agent` / `AgentRuntime`（`run`/`start`/`stream`/`deploy`/`serve`/`plan`）、本地工具 `tool()`、
服务端工具 `httpTool`/`mcpTool`/`apiTool`/`agentTool`/`humanTool`、guardrails、handoff、memory、
liveness、streaming + HITL、结构化输出、`plan_execute` 与静态 Plan builder、调度 API，
以及 LangChain / LangGraph / OpenAI Agents / Google ADK / Vercel AI 框架桥接。

本项目立项时未考虑它的存在。这是一个必须正面回答的重叠问题。

## 两者的执行模型不同

| | 官方 agents 层 | 本项目 |
|---|---|---|
| Agent 循环在哪跑 | **Conductor 服务端**（`plan()` 把 Agent 编译成 workflow definition） | **worker 进程内** |
| 本地进程负责什么 | 只跑 `tool()` 工具 worker | 跑完整 Agent 循环 |
| LLM 凭据 | 服务端 | 本地进程 |
| 对话上下文 | Conductor 存储 | 本地 + 自管 BlobStore |
| MCP 执行位置 | 服务端（`mcpTool` 是 serverTool） | 本地进程 |
| 循环可编程性 | 受 agent schema 约束 | 任意 TypeScript |

官方方案本质上是 ADR-0001 里被我们否决的「Conductor 全编排」路线——只不过由官方把编译工作做掉了，
用户不必手写 `DO_WHILE`/`SWITCH`。ADR-0001 对该路线的技术顾虑（可观测性、payload 传递、迭代耦合）
基本被官方实现消化了，所以**它不再是一个劣势选项**。

## 决策

本项目仅在下列约束**至少成立一条**时才继续：

1. **数据与凭据不出域**：模型 key、对话上下文、工具执行必须留在自己进程内。
2. **循环逻辑需要任意代码**：自研规划/反思/校验逻辑无法用 agent schema 表达。
3. **本地 MCP / 本地副作用工具**：官方 `mcpTool` 由服务端连接，够不着内网与本地。
4. **目标部署是纯 OSS Conductor**，不便依赖服务端 agent 能力的可用性。

四条都不成立时，本项目是纯粹的重复建设，应直接采用官方 agents 层。

因此路线图新增 **M0.5 选型验证**卡点：在写 M1 代码之前产出书面结论。

## 无论结论如何都成立的部分

- ADR-0006（构建在官方 SDK 之上）不受影响。
- `@ca/core` 的状态机、journal、预算、护栏抽象不依赖 Conductor，可迁移。
- 若结论是「改用官方 agents 层」，本项目的剩余价值可能收敛为：
  给官方 `tool()` 工具 worker 补一层预算治理与 OTel GenAI 埋点——一个小得多、但仍有用的包。

---

## 决议（2026-09-05）

选型判断已由项目方给出：**官方 agents 层不满足需求，本项目继续。**

判定理由落在本 ADR 四条判据的第 2 条上，并进一步明确了项目定位：
本项目要交付的是**通用、可扩展、面向多场景**的 Agent 运行时——推理循环必须能被任意
TypeScript 替换（见 [ADR-0010](0010-pluggable-agent-strategy.md)），工具与上下文必须留在本地进程。
这是官方 schema 化 + 服务端执行方案的结构性限制，不是配置能绕过的。

路线图中的 M0.5 卡点随之关闭，里程碑重排为 M1–M6（architecture.md §14）。
本 ADR 的其余内容作为选型依据保留，供后续重新评估时参考。

[ADR-0006](0006-build-on-official-sdk.md)（复用官方 SDK 的**传输层**）不受本决议影响，继续有效。
