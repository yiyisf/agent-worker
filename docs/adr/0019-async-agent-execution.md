# ADR-0019：Agent 执行与编排任务解耦

- 状态：**Accepted**（v0.7）
- Supersedes：[0003](0003-journaled-replay.md)、[0004](0004-lease-strategy.md)、[0007](0007-lease-strategies-revised.md)、[0009](0009-default-callback-strategy.md)、[0014](0014-native-approval-only-suspension.md)、[0015](0015-slice-budget-negotiation.md)、[0016](0016-resume-decision-from-journal.md)
- Amends：[0005](0005-effectful-tool-default.md)、[0012](0012-reliability-by-interception.md)

## 背景

v0.3–v0.6 把 agent **切片塞进 Conductor 任务的执行窗口**里跑：一次 `execute()` 跑一个分片，
跑不完就把引擎状态持久化、带着 `callbackAfterSeconds` 交还任务，下次 callback 再续上。

为了让这个模型成立，我们造了一整条机制链：

- 跨分片的引擎状态持久化（`StateStore`）
- Journaled Replay：恢复 = 重跑循环，每个受管入口被 journal 短路
- 租约 + Fencing token：防止两个 worker 同时跑一个 `runKey`
- 交还预算校验：`callbackAfterSeconds` 不能让任务撞上 `timeoutSeconds`
- `resumePolicy` / `leaseStrategy` 两组配置

## 促成改变的三条核实结论

**1. 队列有 60 秒 unack 窗口，硬编码不可配。**

```sql
-- PostgresQueueDAO.processUnacks，每 60 秒跑一次（UNACK_SCHEDULE_MS = 60_000L）
UPDATE queue_message SET popped = false
WHERE popped = true AND (current_timestamp - interval '60 seconds') > deliver_on
```

Redis/dyno-queues 同样写死 `60_000`。**worker 持有任务超过约 60 秒不回执，
消息会被放回队列、被另一个 worker 并发取走。** 分片模型贴着这条红线跑而不自知 ——
v0.6 的默认 `sliceMs` 是 60 秒。

**2. `updateTask` 对调用方没有所有权校验，且 `SCHEDULED` 不是终态。**

任何持有 `taskId` 的进程都能把任务推向终态，`queueDAO.remove` 会立刻停掉 callback 循环。
也就是说：**后台运行跑完之后可以自己回执，根本不需要等下一次 callback。**

**3. `inputData` 在一个 task 实例的整个生命周期内是冻结的。**

`updateTask` 只写 `outputData` / `status` / `callbackAfterSeconds`，从不碰 `inputData`；
只有重试（新 taskId）才会重新求值 `inputParameters`。
所以 v0.6 设计的「挂起 → 交还 → 外部决定回灌 → 恢复」在同一个 task 实例上**根本不可能** ——
决定送不进来。这条设计一直是错的，只是没被测到。

## 决策

**agent 执行与编排任务解耦。**

- `execute()` **毫秒级返回**，只回答「这个 taskId 的运行现在怎么样了」
- agent 在**后台**从头跑到完成，状态全程在这一次运行的内存里
- 运行结束时**直接** `updateTask` 把任务推向终态
- callback 退化成**心跳检查**：只用来发现后台运行的宿主是不是没了

```
poll → execute(task)                       ← 毫秒级返回
         registry.tryStart(task.taskId)
         ├─ 取得所有权   → host.start(后台跑) → IN_PROGRESS + callbackAfterSeconds
         ├─ 别人在跑     → IN_PROGRESS（带进展）
         ├─ 已是终态     → COMPLETED / FAILED
         └─ 宿主失联     → 按 onOrphan 处置（ADR-0021）

后台运行结束 → registry.finish() → 直接 updateTask(COMPLETED|FAILED)
```

## 后果

**删除**：分片（`sliceMs` / `SliceBudget` / `stopWhen` 预算）、跨分片状态恢复、
journal 与重放、`StateStore`、租约与 fencing token、交还预算校验、
`resumePolicy` / `leaseStrategy`、`EngineTurn` 联合类型、`AwaitingSpec` / `resumeToken`。

**新增**：`RunRegistry`（运行状态的唯一共享真相源）+ `AgentRunHost`（后台运行 + 心跳）。

**保留但收窄作用**：两个受管入口（ADR-0012）仍是可靠性的唯一作用点，
但它们现在做的是**预算闸门、超时闸门、幂等键注入、事件**，不再做 journal 短路。

**`effectful` 的作用点变了**（Amends ADR-0005）：原来是「模糊重放时默认 fail」，
现在是「**超时时按不可重试上报**」—— 副作用是否生效未知，交给工作流的补偿分支决定。

### 明确接受的代价

**进程没了，这次运行就没了，重来一次会重复付费。**

v0.6 的 journal 重放能省下这笔钱，但它的存在前提是分片模型 —— 分片没了，
journal 的短路也就失去了作用点（一次运行内部不存在「重放」这回事）。

步级 journal 作为**可选增强**留给 M2，默认不开。理由：先让默认路径完全走
Conductor 原生机制，等 M2 量出「宿主失联频率 × 平均已完成成本」再决定值不值得加回来。
在有数据之前不加 —— 那是给一个还没被证明存在的问题写代码。

### 换来的东西

| | v0.6 分片模型 | v0.7 异步化 |
|---|---|---|
| worker 持有任务时长 | 一个分片（默认 60s，贴着 unack 红线） | 毫秒级 |
| 并发跑同一任务的可能 | 分片超时即发生，靠 fencing 兜 | 只在注册表占位失败时，且被原子挡住 |
| 跨分片状态 | 持久化 + 重放 | 不存在 |
| 外部依赖 | **Redis 必需**（journal） | 单实例可无；多实例需共享注册表 |
| HITL 等待 | 交还 + 回灌（**不可能实现**，见上） | 运行内部 `await`，天然成立 |
| 长等待占用 worker 槽 | 不占（已交还） | 不占（execute 早就返回了） |
| 代码量 | journal / 租约 / fence / 分片预算 | 一个注册表 + 一个宿主 |
