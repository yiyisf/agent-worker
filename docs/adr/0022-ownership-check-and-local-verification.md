# ADR-0022：上报前归属检查，上报结果不以 HTTP 状态为准

- 状态：Accepted（补充 [ADR-0007](0007-lease-strategies-revised.md) 的 Fencing）
- 日期：2026-10-09

## 背景

ADR-0019 实测 #3 与 #4 表明，**`updateTask` 返回 HTTP 200 不代表上报生效**：

- 已超时任务上迟到的 `COMPLETED` 返回 200，并把原记录从 `TIMED_OUT` 改写成 `COMPLETED`，
  但工作流已推进到重试链，不采用它。运维在 UI 上会看到一条「成功了却没用」的记录。
- 10MB output 返回 200，任务却被置为 `FAILED_WITH_TERMINAL_ERROR`。

v0.6 的 Fencing 只保护 journal 写入（`StateStore` 中单调递增的 `fenceToken`），不覆盖 Conductor 回写。

Projects 版的方案是：fencing 令牌 = `retryCount`，并在最终上报前 `getTask` 检查归属。

## 决策

1. **保留 `fenceToken`，不采用 `retryCount` 作令牌。** 在默认的 `callback` 策略下，下一分片可能被
   另一个 worker 拉到，**taskId 与 `retryCount` 都不变**；保活心跳中断后的接管同样如此（ADR-0024）。
   `retryCount` 区分不了这两个 worker，单调 `fenceToken` 可以。
2. **采纳归属检查**：每次向 Conductor 上报终态（`COMPLETED` / `FAILED`）以及分片交还前，
   先 `getTask(taskId)`：状态不是 `IN_PROGRESS` 或 `workerId` 不是自己时**不上报**，
   记日志并计入 `ca_stale_completion_total`。这是缩小窗口的检查（存在 TOCTOU），真正的保障仍是 fence。
3. **体积在本地强制检查**：`maxOutputBytes`（默认 256KB，低于实测的 1MB 内联上限）在序列化后、上报前校验；
   超限按 `payloadStrategy` 外置 / 截断 / 失败。不依赖服务端外部化，不以 HTTP 状态判断成功。

## 后果

- 每次终态上报多一次 `getTask`；相对一次 Agent 运行的耗时可忽略。
- 僵尸 worker 的副作用无法完全消除，只能靠幂等键（`stepId`）和尽早 abort 缩小窗口 —— 与 v0.6 一致。
- `@ca/testing` 的 MockConductorServer 必须复现实测 #3、#4 的「200 但无效」行为。
