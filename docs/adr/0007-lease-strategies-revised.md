# ADR-0007：三租约策略 —— lease-extend / callback / hybrid

- 状态：Accepted（Revises [ADR-0004](0004-lease-strategy.md)）
- 日期：2026-09-05

## 背景：被证伪的假设

ADR-0004 假设 Conductor 没有「不释放任务的纯心跳」。**该假设错误。**

Conductor 的 `updateTask` 支持 `extendLease: true`，只重置 `responseTimeoutSeconds` 计时器，
不把任务放回队列。官方 SDK 的实现细节：

- 心跳间隔 = `responseTimeoutSeconds × 0.8`
- 100ms `setInterval` 检查，**独立于 poll 循环**——并发槽位占满时仍会心跳
- 失败重试 3 次、间隔 500ms；全失败只记日志，不失败任务
- 生效门槛 `responseTimeoutSeconds ≥ 1.25`（间隔 < 1000ms 则跳过）
- **只重置 `responseTimeoutSeconds`，不延长 `timeoutSeconds`**

## 决策

| 策略 | 机制 | 适用 | StateStore |
|---|---|---|---|
| `lease-extend`（**默认**） | 官方 `leaseExtendEnabled: true`，整个循环在一次 `execute()` 内跑完 | 计算密集、几分钟内完成 | 可选 |
| `callback` | `IN_PROGRESS + callbackAfterSeconds` 交还任务、释放槽位 | 等待人工审批 / 子工作流 / 外部长作业 | 必需 |
| `hybrid`（长时 Agent 推荐） | 计算期 `lease-extend`，进入等待态切 `callback` | 长时 + 有等待 | 必需（仅等待路径写） |

删除 ADR-0004 的 `long-lease`；`yield` 更名为 `callback`，与 Conductor 术语对齐。

Fencing Token 三种模式**全部保留**：心跳降低了重复投递概率，但网络分区、心跳连续失败后仍在跑、
`callback` 交还后被两个 worker 抢到，都仍会导致同一 `runKey` 并发执行。

## 关键推论：`responseTimeoutSeconds` 应该设短

ADR-0004 的 `long-lease` 把 `responseTimeoutSeconds` 设为 `wallClock × 1.5`。这有个糟糕的性质：
**worker 崩溃后要等满整个租约才会重投**——Agent 跑 30 分钟意味着崩溃后卡 45 分钟。

有心跳之后两件事解耦：

- `responseTimeoutSeconds`（**短**，如 60s）= 崩溃检测灵敏度。进程死了心跳就停，60s 内重投。
- `timeoutSeconds`（长，覆盖 `wallClockMs`）= 总执行上限。心跳不延长它。

TaskDef 推导公式据此重写（architecture.md §6.6）。

## 已知陷阱

**`callbackAfterSeconds` 不得超过 TaskDef 的 `timeoutSeconds`，否则任务被判 `TIMED_OUT`。**
SDK 在编译期与运行期各校验一次，运行期超限则夹到 `timeoutSeconds × 0.8` 并告警。
这个坑对 HITL 场景尤其致命——人工审批等一天，`timeoutSeconds` 必须相应放大。

## 代价

- `hybrid` 的状态机比单一策略复杂（同一次 run 可能跨多个 `execute()` 调用）。
  → 由 journal 承载跨调用状态，与崩溃恢复复用同一套机制，不引入第二条路径。
