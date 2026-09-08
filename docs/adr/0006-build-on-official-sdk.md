# ADR-0006：构建在官方 `@io-orkes/conductor-javascript` 之上

- 状态：Accepted（Supersedes [ADR-0002](0002-own-rest-client.md)）
- 日期：2026-09-05

## 决策

删除自研的 `HttpConductorClient` 与 `PollManager`。`@ca/conductor` 降级为**薄桥接层**，
直接依赖官方 SDK `@io-orkes/conductor-javascript`，复用：

| 官方能力 | 我们不再自研 |
|---|---|
| `createConductorClient` / `OrkesClients` | 鉴权（key/secret → JWT）、重试、HTTP/2、TLS、proxy |
| `TaskManager` / `TaskRunner` / `TaskHandler` | poll 循环、并发控制、`domain` 路由、优雅停机 |
| `LeaseTracker` + `leaseExtendEnabled` | `extendLease` 心跳续租（含重试与 0.8 因子） |
| `TaskContext`（`AsyncLocalStorage`） | 任务级上下文、`addLog()`、`setCallbackAfter()` |
| `NonRetryableException` | 终局错误语义 |
| Prometheus metrics + `MetricsServer` | worker 侧 poll/执行/队列指标 |
| `@worker` 装饰器 + registry | 渐进接入既有 worker 工程 |
| `WorkflowClient` / `MetadataClient` | 启动子工作流、注册 TaskDef |

`@ca/conductor` 只保留官方 SDK 不提供、且属于 Agent 语义的部分：
Worker 编译（`AgentDefinition` → `ConductorWorker`）、journal/fencing 接线、
结果映射与 payload 外置、取消检测、由令牌预算驱动的动态并发调节、TaskDef 推导。

## 理由

1. **ADR-0002 的两条前提均不成立**（详见该文档的推翻说明）：鉴权已统一，`TaskManager` 并非黑盒。
2. **自研会漏掉能力**。最直接的证据就是 `extendLease` 心跳——ADR-0004 整个策略选择建立在
   「没有心跳」的错误假设上，而官方 SDK 一直有。自持传输层意味着要持续追平官方的能力演进。
3. **维护成本不对称**。官方 SDK 有集成测试矩阵（OSS / Orkes v4 / v5）和跟随服务端 spec 的
   OpenAPI 代码生成，我们无法用 6 个端点的手写客户端复制这套保障。
4. **生态互通**。用户可以在同一进程里混用官方 `@worker` 普通 worker 和本 SDK 的 Agent worker。

## 代价与缓解

- **依赖体积与耦合**：官方 SDK 的根导出会带出整个 OpenAPI 生成面。
  → `@ca/core` **不依赖**官方 SDK，官方类型只出现在 `@ca/conductor` 内部；
  核心单测与本地运行不需要安装它。
- **受官方 breaking change 影响**：→ 在 `@ca/conductor` 内做一层窄接口收敛，
  升级只改一个包；官方 SDK 声明为 peerDependency，版本范围由用户控制。
- **失去对 poll 的深度控制**：官方 `concurrency` 是静态值。
  → 通过动态调节 concurrency 实现令牌预算反压（architecture.md §6.5），够用。

---

## 实装核实（2026-09-05，M1.3）

按 `@io-orkes/conductor-javascript@4.0.0` 逐个确认本 ADR 的复用清单，全部存在：

| 复用项 | 4.0.0 中的形态 |
|---|---|
| 客户端 | `orkesConductorClient`（= `createConductorClient`）、`OrkesClients` |
| poll 循环与并发 | `TaskManager(client, workers, config)`、`TaskRunner`、`TaskHandler` |
| 心跳续租 | `LeaseTracker`，以及 `ConductorWorker.leaseExtendEnabled` |
| 任务级上下文 | `getTaskContext()` → `TaskContext`（`addLog` / `setCallbackAfter`） |
| 终局错误 | `NonRetryableException` |
| 元数据与工作流 | `MetadataClient`、`WorkflowClient` |

`ConductorWorker` 的实际签名：

```ts
interface ConductorWorker {
  taskDefName: string;
  execute: (task: Task) => Promise<Omit<TaskResult, 'workflowInstanceId' | 'taskId'> | TaskInProgressResult>;
  domain?: string;
  concurrency?: number;
  pollInterval?: number;
  leaseExtendEnabled?: boolean;
}
interface TaskInProgressResult { status: 'IN_PROGRESS'; callbackAfterSeconds: number; outputData?: Record<string, unknown>; }
```

`TaskInProgressResult` 正是 callback 分片交还的形状，与 §5.3 的设计直接对上。
peerDependency 相应收紧为 `>=4.0.0`。

**已知摩擦**：该 SDK 声明 `zod ^3.22.0` 的 peer，与 `ai@7` 所需的 zod 4 冲突。
我们只用它的传输层、不用需要 zod 的 `/agents` 子路径，因此在根 `package.json` 用
`pnpm.peerDependencyRules.allowedVersions` 显式放行并记录理由，而不是降级 zod。
