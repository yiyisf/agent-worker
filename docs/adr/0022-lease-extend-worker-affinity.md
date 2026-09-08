# ADR-0022：用 extendLease 心跳保证「一次执行始终在同一 worker」

- 状态：**Accepted**（v0.8）
- Supersedes：[0021](0021-orphan-run-policy.md)
- 部分取代 [0019](0019-async-agent-execution.md)：「一次运行从头跑到完成、不切片」的结论**保留**；
  异步宿主、运行注册表、callback 协议被本 ADR 取代，且 **0019 的第一条论据经复核不成立**（见下）

## 需要更正的一条事实

ADR-0019 的第一条论据是：

> 队列有 60 秒 unack 窗口，worker 持有任务超过它，消息会被放回队列被另一个 worker 并发取走。

**这条是错的。** `ExecutionService.poll` 的最后一行是：

```java
tasks.forEach(this::ackTaskReceived);
// ackTaskReceived(Task) → queueDAO.ack(QueueUtils.getQueueName(task), task.getTaskId())
// PostgresQueueDAO.ack  → DELETE FROM queue_message WHERE queue_name = ? AND message_id = ?
```

**poll 成功之后任务已经从队列里删掉了。** 那 60 秒 unack 窗口（`processUnacks` 把
`popped = true` 且超期的行改回 `popped = false`）只覆盖 `pop` 到 `ack` 之间的**毫秒级**间隙，
不是 worker 持有任务时长的红线。

## 两种模式的真实差别

| | callback | **extendLease** |
|---|---|---|
| poll 之后任务在队列里吗 | — | **不在**（被 `ack` 删除） |
| 每次交还做什么 | `updateTask(IN_PROGRESS)` → `postpone` **写回队列** | 不交还 |
| 下一次谁执行 | 队列里谁先 `pop` 谁得 → **任意 worker** | **只能是当前这个** —— 别人根本看不到它 |
| 保活 | 交还时重置 `deliver_on` | `updateTask({extendLease:true})` → `extendLease()` 只 `setUpdateTime`，`return null`，不碰队列 |
| worker 崩了 | 队列消息到点被别人取走 | `responseTimeout` → `TIMED_OUT` → 消耗一次 `retryCount` → **新 taskId 重新分配** |

v0.6 之前选 callback、v0.7 又在它之上造异步宿主，都是建立在「callback 能保证同一 worker」
或「worker 不能长时间持有任务」这两个错误认知之上的。

## 决策

**用 extendLease 心跳模式。`execute()` 就是把 agent 从头跑到完。**

```ts
{
  taskDefName,
  leaseExtendEnabled: true,     // ← 官方 LeaseTracker 接管心跳
  async execute(task) {
    const outcome = await runAgent({ ... });   // 跑多久都行
    return toTaskResult(outcome);
  }
}
```

**心跳不由本项目实现。** 官方 SDK 的 `LeaseTracker` 已经做好了：读
`task.responseTimeoutSeconds`，按 ×0.8 的间隔调 `updateTask({ extendLease: true })`，
跑在独立的 100ms 定时器上（并发槽占满也照常心跳）。我们只需要打开开关并校验取值。

服务端要求 **≥ 3.10.7**（`TaskResult.extendLease` 自该版本引入），启动时探测。

## 后果

**删除**（本 ADR 相对 v0.7）：`AgentRunHost`、`RunRegistry` 及其内存/Redis 实现、
callback 协议状态机、所有权与心跳自实现、孤儿处置（`onOrphan` / `orphanAfterMs` /
`callbackAfterSeconds`）、注册表一致性套件。

**SDK 默认零外部依赖。** `@ca/memory` 收缩为可选的 `BlobStore`（只在结果超出
`outputData` 预算时用得上）。

**TaskDef 取值方向反转**：`responseTimeoutSeconds` 从 v0.7 的「用不上的兜底 3600」
变成**崩溃检测灵敏度**，默认 **60 秒** —— worker 活着就一直有心跳、任务想跑多久跑多久；
worker 挂了 60 秒后被判 `TIMED_OUT`、消耗一次 `retryCount`、新 taskId 重新分配。
`retryCount` 因此**是真的会被 worker 崩溃消耗的**，不可为 0。

**启动时必须拒绝的配置错误**：`responseTimeoutSeconds < 1.25` 时官方
`LeaseTracker` 算出的间隔 < 1000ms，会**静默跳过不发心跳**，任务必然被判超时。
`assertHeartbeatViable()` 在编译 worker 时就拒绝这种配置。

## 明确接受的两条代价

**1. 运行途中无法更新 `outputData`。**

`updateTask` 的实现是 `if (taskResult.isExtendLease()) { extendLease(taskResult); return null; }`
—— 在碰 `outputData` **之前**就 return 了；而正常的 `updateTask(IN_PROGRESS)` 会把任务
`postpone` 回队列，那就破坏了亲和。

| 通道 | callback 模式 | extendLease 模式 |
|---|---|---|
| `outputData.progress`（权威） | 每次交还都能更新 | **只在结束时写一次** |
| Conductor Task Log | 运行中可写 | **运行中可写，不受影响** |

「运行中就要知道进展」（§10.4）**仍然满足** —— 靠 Task Log，`addTaskLog` 不碰队列。
但工作流用 `${ref.output.progress.step}` 做**运行中**分支判断这条路没了（只有终态才有值）。

**2. 一个长跑 agent 占住一个并发槽的全程。**

`concurrency` 的含义从「每秒处理几个任务」变成「**同时最多跑几个 agent**」。
这是亲和的必然代价，也是正确的代价 —— 一次 agent 运行本来就该独占一份资源配额。

## 与「进程挂了重复烧钱」的关系

worker 崩溃时整次运行重来的代价没变（ADR-0019 已接受），但归因更清楚了：
它现在走的是 Conductor 的标准重试路径（`TIMED_OUT` → `retryCount` → 新 taskId），
而不是我们自己发明的孤儿接管。要止血仍然需要 checkpoint 或 journal，
仍然是 M2 先量数据再决定（§15.3）。
