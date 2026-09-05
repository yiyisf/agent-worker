# ADR-0009：默认租约策略选 `callback`

- 状态：Accepted（改写 [ADR-0007](0007-lease-strategies-revised.md) 的默认值，不改其策略集合）
- 日期：2026-09-05

## 背景：extendLease 的版本可用性

ADR-0007 把 `lease-extend` 定为默认。核实 Conductor OSS 服务端源码后补充两项事实：

**版本范围**（按 git tag 抽样 `TaskResult.java` 与服务端处理逻辑）：

| 版本 | `extendLease` |
|---|---|
| v3.0.0 / v3.5.0 / v3.9.0 / v3.10.0 – **v3.10.6** | ❌ 无字段、无服务端处理 |
| **v3.10.7** 起（3.11 / 3.13 / 3.15 / 3.17 / 3.19 / 3.20 / 3.21 / main 均确认） | ✅ 有 |

目标部署 **v3.21.21 支持** `extendLease`。但 `callbackAfterSeconds` 是 3.x 全系可用的。

**语义**（v3.21.21，`WorkflowExecutorOps` + `DeciderService` + `ExecutionDAOFacade`）：

- `extendLease` 只做 `taskModel.setUpdateTime(now)` 并 `return null`，从不触碰 `queueDAO` —— 确是真心跳。
- responseTimeout 判定用 `noResponseTime = now - task.getUpdateTime()` 比对
  `adjustedResponseTimeout = responseTimeoutSeconds + callbackAfterSeconds`。

## 决策

**默认策略改为 `callback`**；`lease-extend` 与 `hybrid` 保留为可选，并要求服务端 ≥ v3.10.7
（SDK 启动时探测，不满足则拒绝启动并提示改用 `callback`）。M1 只实现 `callback`。

## 理由

1. **恢复路径被高频验证**（最重要）。`callback` 让「持久化 journal → 换个进程从 journal 继续」
   变成**每次运行都要走的主路径**，而不是只在崩溃时才跑的旁路。
   只在故障时才执行的代码就是不可靠的代码；把恢复逻辑放到主路径上，等于每次运行都在做一次恢复演练。
   `lease-extend` 恰恰相反——正常路径永远不碰 journal，恢复代码可能几个月都跑不到一次。
2. **兼容面最广**。`callbackAfterSeconds` 3.x 全系可用，`extendLease` 要 ≥ 3.10.7。
   作为一个通用 SDK 的默认值，应该选无版本门槛的那个。
3. **不霸占并发槽位**。长时 Agent 分片执行，等待外部信号时零占用；`lease-extend` 全程占着一个槽。
4. **配置心智低**。服务端把 `callbackAfterSeconds` 加进容忍窗口，所以它不必小于 `responseTimeoutSeconds`，
   少一个容易配错的约束。
5. **与 HITL、子工作流等待天然一致**。这些场景本来就必须交还任务，默认 `callback` 意味着它们不是特例。

## 代价与缓解

- **`StateStore` 从可选变必需**：→ 这本来就是生产部署的合理要求；SDK 启动时校验，`memory` 实现只供本地开发。
- **journal 写放大**：→ 由 `leaseSliceMs`（默认 60s）调节，M2 压测给出选型表；指标里暴露「平均分片数」直接观测。
- **每片一次排队往返带来的延迟**：→ 对延迟极敏感的场景改用 `lease-extend`（需 ≥ 3.10.7），这正是它保留的意义。

## 连带的配置约束（源码核实，写入 §6.6）

1. `timeoutSeconds` 从 `startTime` 起算且**不加** `callbackAfterSeconds`，
   因此必须覆盖「所有分片执行 + 所有等待」的总和。HITL 等一天就得按一天配。
2. `retryCount` **不可为 0**：responseTimeout 超时会把任务判 `TIMED_OUT` 并消耗一次重试配额。
3. `timeoutPolicy` 对 responseTimeout **无效**（该路径直接 `timeoutTask()`），只作用于 `timeoutSeconds`。
