# ADR-0018：进展反馈双通道 —— `outputData.progress` 权威，Task Log 尽力而为

- 状态：Accepted
- 日期：2026-09-05

## 背景

一个 Agent task 可能跑十几分钟。若只在跑完时回写结果，Conductor UI 上就是一个"卡了十几分钟"的任务，
运维无法区分「正常在跑」与「卡死了」；工作流里的其他环节也无从知道它到哪一步。

**要反馈的是「进展」，不是执行过程的实时输出。** 三者必须分清：

| | 内容 | 通道 | 频率 |
|---|---|---|---|
| 实时输出 | token delta、工具入参出参全文 | `StreamSink`（Redis / SSE） | 高频、无界 |
| **进展** | 到第几步、当前在做什么、累计 token 与成本 | 本 ADR | 低频、有界 |
| 最终结果 | 结构化输出 | `outputData` | 一次 |

把 token 流写进 task log 会瞬间打爆服务端，而且那不是编排引擎该消费的东西 ——
编排引擎要的是「它还活着、走到哪了」，不是「它说了什么」。

## 服务端约束（v3.21.21 源码核实）

Task Log 看似是天然通道，但有三条硬约束，直接决定了它**不能作为权威来源**：

| 约束 | 影响 |
|---|---|
| `ExecutionDAOFacade.addTaskExecLog()` 先判 `isTaskExecLogIndexingEnabled()`，再写 `indexDAO` | 部署若用 `NoopIndexDAO`（`conductor.indexing.enabled=false`，无 ES/OpenSearch 的常见 OSS 配置），日志被**静默丢弃** |
| `taskExecLogSizeLimit` 默认 **10** | **单次调用**超过 10 条会被静默截断（`logs.stream().limit(...)`），不是每任务上限 |
| `asyncIndexingEnabled` 默认 `false` | 索引写在请求路径上，写太频会拖慢服务端 |

## 决策

**两条通道，可靠性分级：**

1. **`outputData.progress`（权威）**。`callback` 分片交还本身就是一次 task update，
   顺手把 `ProgressReport` 写进 `outputData`，**零额外请求**。
   这是唯一能被工作流消费的通道 —— 其他 task 可读 `${agent_ref.output.progress.step}`
   做 SWITCH 分支、超时告警或通知。
2. **Conductor Task Log（尽力而为）**。优点是分片内也能写，不必等交还；
   但受上述三条约束，只当作**给人在 UI 上看的镜像**，丢了不算故障。

进展的真相在 `outputData.progress` 与 journal 里。

**写入策略**（全部由上述约束反推）：

- 节流 `progressIntervalMs` 默认 15s；`phase` 变化立即写一次（leading edge），两者取或。
- 单次 `addLog` 调用 **≤ 10 条**；单 run 总量默认 ≤ 200 条，超限后只写阶段变化。
- 异步 fire-and-forget，失败只记本地日志。
- 内容为一行结构化文本，截断 512 字符，**不放 payload、不放工具入参出参、不放密钥**。
- **启动自检**：探测部署是否启用了 task log 索引；未启用则告警一次并自动关闭通道二 ——
  不能让用户以为写了、其实什么都没有。

**产生源**是已有的两个受管入口 + 分片边界，不需要引擎额外配合；
引擎若有原生回调（AI SDK 的 `onStepFinish`、harness 的 lifecycle callbacks），
适配器可把 `phase` 填得更语义化。`capabilities.progress` 声明能到 `'step'` 还是只有 `'turn'`。

## 跨重试的连续性

task log 挂在 `taskId` 上。`callback` 交还不换 `taskId`，分片之间连续；
但 responseTimeout → `TIMED_OUT` → 重试会换新 `taskId`，日志断开。
因此进展**同时写 journal**，新 `taskId` 的第一条 log 输出
「从第 N 步恢复（累计 X tokens / $Y）」把断点接上。

## 代价

- `outputData.progress` 只在分片边界更新：`lease-extend` 策略下整个运行只更新一次。
  → 这是选 `callback` 作默认策略的又一个理由（ADR-0009）。
- 多写一份 progress 进 journal。相对 journal 本身的体量可忽略。
