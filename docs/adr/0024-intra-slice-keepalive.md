# ADR-0024：分片内保活

- 状态：Accepted（Amends [ADR-0006](0006-build-on-official-sdk.md)、[ADR-0009](0009-default-callback-strategy.md)）
- 日期：2026-10-09

## 背景

默认 `callback` 策略下，分片边界由 `SliceBudget` 决定（ADR-0015），但它是**软**预算：
引擎只能在两次受管调用之间停下。一次模型调用或一个工具跑 10 分钟，分片就会跨过
`responseTimeoutSeconds`，任务被判 `TIMED_OUT`、消耗一次重试、换新 taskId —— 而 worker 其实活得好好的。
v0.6 在 `callback` 模式下没有任何分片内续约手段。

可选机制有两个：

| 机制 | 依据 | 风险 |
|---|---|---|
| `extendLease: true` | 源码阅读：只改 `updateTime`，不碰队列（ADR-0009）；需 ≥ 3.10.7 | **未实测** |
| `IN_PROGRESS` + `callbackAfterSeconds` | **已实测**（ADR-0019 #1）：取值 = `responseTimeoutSeconds` 时安全 | 每次心跳都会推迟队列消息；`callbackAfterSeconds` 小于心跳周期即造成重复投递 |

官方 `LeaseTracker` 实现了前者，但间隔固定为 `responseTimeoutSeconds × 0.8`、重试 3 次 × 500ms，
**全部失败只记日志、不中止任务**（已在 4.0.0 源码中核实）。余量只有 0.2 倍，且失败后 worker 继续执行，
正是 Fencing 要防的「心跳断了还在跑」。

## 决策

1. `@ca/conductor` 自持一个**分片内保活定时器**，执行期间运行，分片交还或终态上报前停止。
2. 参数采用 Projects 版实测得出的 `planHeartbeat`：
   - 间隔 = `max(5s, responseTimeoutSeconds × 0.4)`，且必须 ≤ `callbackAfterSeconds × 0.4`，否则拒绝启动
     （即 `responseTimeoutSeconds` 至少 13s；§6.6 的 30s 下限已满足）；
   - **连续 2 次失败即通过 `AbortSignal` 中止本次运行**，赶在任务被他人接管前停下。
3. 两种模式，按服务端能力选择：
   - `extend-lease`（≥ 3.10.7 默认）：发送 `extendLease: true`，不碰队列；
   - `in-progress`（< 3.10.7，或 `extendLease` 实测不通过时）：`IN_PROGRESS` + `callbackAfterSeconds = responseTimeoutSeconds`，
     可顺带携带 `AgentTaskInterimOutput.progress`。
4. **不变量**：任何 `IN_PROGRESS` 更新的 `callbackAfterSeconds` 不得小于保活间隔。分片交还时的
   `callbackAfterSeconds` 是「等待时长」，由 `checkHandbackBudget` 另行约束。
5. 不启用官方 `leaseExtendEnabled`，避免两套心跳并存。

## 后果

- 偏离 ADR-0006「不自研心跳」：理由是官方实现的余量与失败语义不满足 Fencing 的要求；实现约百行。
- `extend-lease` 作为默认的前提是 `contract-verify` 新增的 `extendLease` 实验通过（ADR-0019 决策 3），
  M1 出口前必须完成；未通过则默认改为 `in-progress`。
- `in-progress` 模式下 worker 崩溃后，约 `callbackAfterSeconds` 后同一 taskId 可被他人拉到
  （不消耗重试），由 journal 续跑（ADR-0016）、由 `fenceToken` 拒绝旧 worker。
