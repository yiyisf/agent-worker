# ADR-0020：运行标识就是 `taskId`；TaskDef 是只写不读的注册期契约

- 状态：**Accepted**（v0.7）
- 相关：[0019](0019-async-agent-execution.md)

## 背景

异步化之后，`execute()` 每次被调用都要回答一个问题：
**这是同一次执行的第 N 次 callback，还是一次全新的执行？**

v0.6 自己拼了一个恢复锚点：

```
runKey = `${workflowInstanceId}:${taskReferenceName}:${epoch}`
epoch  = resumePolicy === 'fresh-per-retry' ? retryCount : 0
```

同时，`worker.ts` 在运行期读取了两个 TaskDef 推导值：
`responseTimeoutSeconds` 当租约 TTL、`timeoutSeconds` 当交还预算上限。

## 核实

**运行态 `Task` 上的标识行为（3.21.21 源码）：**

| 标识 | 同一次执行的多次 callback | 重试 | 新工作流实例 |
|---|---|---|---|
| **`taskId`** | **不变** | **新生成** | 新生成 |
| `pollCount` | 1, 2, 3… 递增 | 重置为 0 | 从 0 |
| `retryCount` | 不变 | +1 | 0 |
| `retriedTaskId` | 不变 | 指向上次 taskId | 空 |
| `outputData` | 上次 callback 写的 | 上次 attempt 最后写的 | 空 |
| `inputData` | **冻结** | 重新求值 | — |

依据：callback 走 `updateTask` + `queueDAO.postpone`，不换 taskId；
重试走 `DeciderService.retry()` / `WorkflowExecutorOps:453`，两条路径都
`setTaskId(idGenerator.generate())` + `setPollCount(0)`。

**TaskDef 的 21 个字段，谁读它们：**

| 字段 | 实际读取者 |
|---|---|
| `name` | 双方（worker 拿它 poll） |
| `inputTemplate` | 服务端 `getTaskInputV2()` → `putIfAbsent` 进 `inputData` |
| `inputKeys` / `outputKeys` | **无人**。全库除 getter 与 proto 映射外零读取点 |
| `inputSchema` / `outputSchema` / `enforceSchema` | **无人**（OSS 3.21.21 只有 proto 映射，无校验逻辑） |
| 其余（retry / timeout / rateLimit / isolation…） | **服务端调度层** |

**没有 worker 亲和机制。** 队列名只由 `taskType[:domain][@ns][-isolation]` 构成，
`workerId` 只用于日志、`setWorkerId` 记录与 `updateTaskLastPoll` 指标；
全库 grep `sticky|affinit|preferredWorker` 无结果。
SDK 用的 `POST /api/tasks/update-v2` 是「更新完顺手替这个 worker poll 一次同队列」的
链式优化，返回队首任务，不保证是刚交还的那个。

## 决策

**1. `runId = task.taskId`。**

不再自拼 `runKey` —— Conductor 已经给了语义完全吻合的标识。
`pollCount` / `retryCount` / `retriedTaskId` 只用于日志与业务判断，**不参与身份判定**。

**2. TaskDef 是只写不读的注册期契约。**

`deriveTaskDef(spec)` 的产物交给 `MetadataClient.registerTask`，
**绝不出现在 `execute()` 的调用栈上**。worker 运行期需要的一切都来自入参 `task`。

原来那两处读取一并**删除**，因为需求本身不存在：

- 租约 TTL → 租约没了（ADR-0019）
- 交还预算上限 → 超时是引擎的事，worker 不参与（`timeoutSeconds` 注册为 0）

**3. 运行态输入输出没有命名空间。**

`task.inputData` **原样**就是 agent 的输入；`outputData` 由桥接层生成。
定义态的 `inputKeys` / `outputKeys` / `inputTemplate` 一概不参与 —— 前两者服务端不读，
后者由服务端在调度那一刻合并进 `inputData`，worker 看到的已经是结果。

**4. 多实例部署必须用共享注册表。**

既然无亲和，`MemoryRunRegistry` 只在单进程内成立。多实例用 `RedisRunRegistry`。

## 后果

- 删除 `runKeyOf()`、`RESUME_INPUT_KEY`、`checkHandbackBudget()`、`lease.ts` 整个模块
- `worker.ts` 的 `execute()` 不再 import 任何 `DerivedTaskDef` 相关的东西，
  由测试守住这条边界
- `deriveTaskDef` 保留 `diffTaskDefs()`，但它明确是**运维视角**的漂移告警：
  线上定义改了也不影响 `execute()` 的行为，因为它根本不读
