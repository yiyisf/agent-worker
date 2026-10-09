# ADR-0025：一个任务只运行一个 agent，协作交给 Conductor

- 状态：Accepted
- 日期：2026-10-09

## 背景

Agent 框架普遍支持子 agent 与内部编排；harness 引擎（Claude Code、Deep Agents 等）更是自带子 agent 工具。
如果在 worker 内部做协作，重试、超时、审批与观测会分散在 Conductor 与 worker 两处，
而且子 agent 的模型调用与工具执行多半落在我们拦不到的地方（ADR-0012、§4.4）。

v0.6 没有明确这条原则。Projects 版以 ADR-0001 定下。

## 决策

- 每个 Conductor task 只运行一个 agent。并行、分支、审批、多 agent 协作全部用 Conductor 表达
  （`FORK_JOIN`、`DYNAMIC_FORK`、`SWITCH`、`HUMAN`、`SUB_WORKFLOW`）。
- harness 引擎适配器**默认禁用子 agent 工具**；需要开启时在 `engineOptions` 显式声明，并在启动时告警
  「子 agent 的成本与副作用不在受管入口内」。
- M5 的 `ConductorWorkflowTool` 与此一致：它启动的是 Conductor 工作流，不是进程内子 agent。

## 后果

- 编排在引擎层完全可见，worker 保持简单。
- 任务间交接必须显式，通过信封的 `handoffs`（ADR-0020）。
- 原先依赖子 agent 的模式需要改写为 workflow。
