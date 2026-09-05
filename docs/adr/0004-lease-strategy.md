# ADR-0004：long-lease 与 yield 双租约策略

- 状态：**Revised by [ADR-0007](0007-lease-strategies-revised.md)**（2026-09-05）——核心假设被证伪
- 日期：2026-09-05

## 背景

Conductor 的 `responseTimeoutSeconds` 在 worker 未回写时会重投任务。
我们假设 Conductor **没有**「不释放任务的纯心跳」原语：把任务 update 为 `IN_PROGRESS` 会重置计时，
但配合 `callbackAfterSeconds` 会让任务重新可被任意 worker poll。此假设需在目标版本实测确认。

## 决策

提供两种策略，由 Agent 定义选择：

- `long-lease`（默认）：由 `limits.wallClockMs` 反推 `responseTimeoutSeconds`（×1.5）写入 TaskDef，
  整个 run 占用一个租约，结束时一次性回写。
- `yield`：在 step 边界或 `leaseSliceMs` 到期时持久化 journal，以 `IN_PROGRESS + callbackAfterSeconds`
  交还任务并释放槽位，下次 poll 由 journal 恢复。

两种策略都启用 **Fencing Token**：`StateStore` 中 `runKey` 的租约记录带单调递增 `fenceToken`，
journal 写入与 Conductor 回写都需携带，落后者被拒绝并自我放弃。

## 理由

- 短 Agent（秒到分钟级）用 `long-lease` 最简单，且不强制引入 StateStore。
- 长 Agent、人工审批、等待子工作流必须用 `yield`，否则一个 run 会长期霸占租约与 worker 槽位。
- 任务被释放后可能被并发 poll，Fencing 是把「重复执行」降级为「浪费一次调用后放弃」的关键。

## 代价

- `yield` 强依赖持久化 StateStore，且有 journal 写放大。→ 启动时做配置校验，M2 压测量化写放大。

---

## 修订原因（2026-09-05）

本 ADR 的核心假设——「Conductor 没有不释放任务的纯心跳原语」——**是错的**。

Conductor 的 `updateTask` 支持 `extendLease: true`：只重置 `responseTimeoutSeconds` 计时器，
**不把任务放回队列**。官方 SDK 已封装为 `leaseExtendEnabled` 开关和可独立使用的 `LeaseTracker`。

由此，`long-lease`（把 `responseTimeoutSeconds` 设得比运行时长还长）这个策略不但没必要，
而且**有害**：它让崩溃检测时间等于整个租约时长。修订后的三策略见
[ADR-0007](0007-lease-strategies-revised.md)。

保留有效的部分：Fencing Token 机制仍然必要（心跳降低但未消除重复投递），`callback` 策略
（原 `yield`）仍然是等待外部信号的正确做法。
