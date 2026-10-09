# ADR-0020：统一出入参信封与 `outcome` 语义

- 状态：Accepted（取代 §6.2 的 `COMPLETED + ok:false` 约定）
- 日期：2026-10-09

## 背景

v0.6 只给出了 `outputData` 的松散草图（`{ ok?, result?, progress?, specHash, usage, ... }`），
没有入参约定。任务间只能通过 Conductor input / output 交接，上下游各写各的会让 workflow 映射变成猜谜。
Projects 版设计了一套完整信封并已实现、有单测，本 ADR 采纳它并按本仓库的架构补齐。

## 决策

### 入参 `AgentTaskInput`

`schemaVersion`、`payload`，可选 `instructions` / `context.handoffs` / `context.artifacts` / `execution` / `trace`。
**顶层未知字段拒绝**，以便尽早发现 workflow 映射里的拼写错误。

桥接层把 `{ payload, instructions, handoffs, artifacts }` 作为 `engine.run({ input })` 的 `input`；
`execution` 与 spec 的 `limits` 合并（**只能收紧，不能放宽**，`model` 必须在 spec 白名单内）；
`trace` 进入 `RunContext`。Conductor 系统字段（taskId、retryCount 等）不进入 input。

### 出参：三种形状，按任务状态区分

| 形状 | 何时 | Conductor 状态 |
|---|---|---|
| `AgentTaskOutput` | 运行结束（含业务信号） | `COMPLETED` |
| `AgentTaskFailureOutput` | 运行失败 | `FAILED` / `FAILED_WITH_TERMINAL_ERROR` |
| `AgentTaskInterimOutput` | 分片交还、等待审批、保活心跳 | `IN_PROGRESS` |

`AgentTaskOutput.outcome ∈ completed | needs_approval | needs_input | escalated`。
业务信号在 Conductor 看来都是 `COMPLETED`，由 workflow 的 `SWITCH` 分支（ADR-0021）。
**这取代 v0.6 的 `ok:false`**：「做不到但流程该继续」= `outcome: 'escalated'`。

相对 Projects 版的调整：

- `run.framework` → `run.engine`（AgentEngine id）；新增 `run.specHash`（§7.2）、`run.slices`；
  `resumedFromCheckpoint` → `resumed`（journal 重放）；`compactions` 改为可选（拦截式架构下 core 不一定知道）。
- transcript 用 `artifacts` 中 `kind: 'transcript'` 的 `ArtifactRef` 表达，不另设字段。
- `AgentTaskInterimOutput` 是新增形状：`{ schemaVersion, progress }`，即 ADR-0018 的权威进展通道。

### 引擎输出到信封的约定

引擎 `done.output` 若是含 `outcome` 字段的对象，按 `{ outcome, result?, summary?, request?, artifacts? }` 解释；
否则视为 `{ outcome: 'completed', result: output }`。`summary` 默认 ≤ 2000 字符。

## 后果

- workflow 可以把上游 output 直接映射为下游 `Handoff`（`Handoff` 是 `AgentTaskOutput` 的结构子集）。
- 信封变更必须递增 `schemaVersion` 并附 changeset；快照测试防止无意变更。
- TaskDef 的 `inputKeys` / `outputKeys` 由信封字段生成。
- 信封类型与 zod schema 放在 `@ca/conductor/envelope`：它是 Conductor I/O 契约，`@ca/core` 保持零依赖。
