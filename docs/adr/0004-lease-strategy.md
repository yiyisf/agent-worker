# ADR-0004：long-lease 与 yield 双租约策略

- 状态：Accepted（含一条待验证假设）
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
