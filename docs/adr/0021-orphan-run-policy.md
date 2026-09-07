# ADR-0021：孤儿运行默认接管重跑，不消耗编排引擎的重试配额

- 状态：**Accepted**（v0.7）
- 相关：[0019](0019-async-agent-execution.md)、[0020](0020-runid-is-taskid.md)
- Supersedes：[0016](0016-resume-decision-from-journal.md)

## 背景

后台运行宿主是**进程内**的：`execute()` 起一个不 await 的任务，进程没了，运行就没了。

ADR-0016 曾用「自己的 journal 里有没有终态条目」来区分「worker 崩了」与「业务上真失败了」，
因为 Conductor 的 `retryCount` 两种情况都 +1，分不出来。
journal 删除之后需要一个新答案。

## 决策

**用运行注册表的心跳判断宿主是否还活着，用 `onOrphan` 决定怎么处置。**

```
失联判据：now - record.updatedAt > spec.conductor.orphanAfterMs   （默认 90 秒）
心跳来源：后台宿主每 15 秒刷新一次，并顺带写入最新进展
```

| `onOrphan` | 行为 | 代价 |
|---|---|---|
| **`restart`（默认）** | 下一个接到 callback 的 worker **接管重跑整次运行**。taskId 不变，`registry.attempts + 1`，**不消耗 Conductor 的 `retryCount`** | 已完成的部分重复付费 |
| `fail` | 判失败交回引擎，由 `TaskDef.retryCount` 决定是否重试 | 消耗重试配额；行为等价但语义更重 |

`restart` 有上限：`attempts` 达到 `maxAttempts`（默认 3）后注册表直接把记录判为
`failed`，不再接管。此后走 Conductor 的正常失败路径。

## 为什么默认 `restart`

**语义更准。** 宿主失联不是「这次任务失败了」，而是「跑它的那个进程没了」。
用 Conductor 的重试配额去表达一个进程生命周期事件，会让真正的业务失败无配额可用 ——
默认 `retryCount = 3`，被两次滚动发布吃掉就只剩一次。

**更便宜。** 接管走的是同一个 taskId，不经过 decider 的 retry 路径，
不新建 task 实例、不重新求值 `inputParameters`、不产生额外的 DB 写。

**边界清晰。** `retryCount` 从此只表达一件事：**业务失败重试**。

## 明确接受的代价

接管 = **整次运行重来**，已完成的模型调用要重新付钱。

这是 ADR-0019 删除 journal 的直接后果。缓解手段有三层：

1. `restart` 有 `maxAttempts` 上限，不会无限烧钱
2. 优雅停机时 `host.drain()` 会等在跑的运行结束，正常发布不产生孤儿
3. 真正的止血手段（步级 journal）留给 M2，且**要先有数据**：
   §15.3 第 1 条要求量出「宿主失联频率 × 接管时已完成的成本」再决定

## 实现约束

- `orphanAfterMs` 必须 ≥ 3 × 心跳间隔，否则正常运行会被误判失联
- 心跳来自受管入口产生的进展，所以 `capabilities.progress === 'none'` 的引擎
  判定会变迟钝 —— §4.4 对此告警，建议放宽 `orphanAfterMs`
- 接管必须原子：`tryStart` 在判定失联与改写 owner 之间不能有窗口，
  否则两个 worker 会同时接管。Redis 实现因此用 Lua
- 旧宿主如果后来又活过来了，它的 `finish()` 会因为 owner 不匹配被拒绝，
  结果被丢弃 —— 不会覆盖新 owner 的运行
