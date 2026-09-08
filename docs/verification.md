# M1 验证清单（v0.8 extendLease 模式）

> 这一步需要在**你的机器上**执行：本项目的开发环境没有 docker daemon，
> 所以真实 Conductor 上的验证无法在这里完成。下面每一条都给了命令、预期输出、
> 以及「看到什么才算通过」。

## 0. 先决条件

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 20、pnpm 9 | `pnpm install` |
| Docker（带 daemon） | 起 Conductor |
| Conductor OSS | **≥ 3.10.7**（`TaskResult.extendLease` 自该版本引入） |
| Redis | **不需要**。SDK 默认零外部依赖 |
| LLM key | **不需要**。示例默认用确定性的脚本化模型，验证零成本、可重复 |

### ⚠️ 关于 Conductor 镜像版本

**Docker Hub 上没有 `3.21.21` 这个 tag。** `conductoross/conductor` 的 3.21.x 只发布了
`3.21.24-rc.1`，最近的已发布稳定版是 `3.22.x`。

- `docker-compose.yml` 默认用 **`3.22.3`**。
- 要对着你自己的 3.21.21 构建验证：`CONDUCTOR_IMAGE_TAG=3.21.21 docker compose up -d`。
- 我们依赖的服务端语义都是照着 **3.21.21 的源码**核实的，
  见 [architecture.md §2.2](architecture.md#22-服务端语义v32121-源码核实结论)。

---

## 1. 起环境

```bash
docker compose -f examples/minimal-agent/docker-compose.yml up -d
curl -sf http://localhost:8080/health && echo OK
```

**预期**：`OK`。Conductor 首次启动要建表，约 60–90 秒。UI 在 <http://localhost:8080>。

> compose 选的是 **postgres 变体**（`CONFIG_PROP=config-postgres.properties`）：
> 不需要 Elasticsearch，且 `conductor.indexing.type=postgres` 意味着
> **task log 照样能存** —— §10.4 的运行中通道可以被真正验证到。
> compose 里的 Redis 服务是**可选的**（只给 `BlobStore` 用），SDK 本身不连它。

---

## 2. 跑单元与集成测试

```bash
pnpm install
pnpm build
CONDUCTOR_SERVER_URL=http://localhost:8080/api pnpm test
```

**预期**：`57 passed`（其中 3 个 e2e 用例此前会被跳过，现在应当执行）。

---

## 3. 手动跑一次，看真实输出

```bash
pnpm --filter @ca-example/minimal-agent start
```

**预期输出**（关键行）：

```
① 注册 TaskDef 与工作流定义…
② 启动 worker（poll 循环由官方 TaskManager 托管）…
   [order_assistant] extendLease 心跳：每 4s 一次（responseTimeoutSeconds=5），由官方 LeaseTracker 托管
③ 触发一次运行…
   workflowId = <uuid>
   任务状态轨迹： IN_PROGRESS(poll=1) → IN_PROGRESS(poll=1) → … → COMPLETED(poll=1)
④ 结果
   status  = COMPLETED
   运行时长 = 12.3s（responseTimeoutSeconds = 5s）
   pollCount = 1 / retryCount = 0
   output  = {
     "answer": "订单 A-1001 已发货，预计明天送达。",
     "progress": { "phase": "done", "step": 3, "usage": {...} },
     "usage": { "tokens": 360, "costUsd": 0.0018 },
     "taskId": "<taskId>"
   }
   真实调用：模型 2 次 / 工具 1 次
   ↑ 运行时长远超 responseTimeoutSeconds 却没被判超时 = extendLease 心跳生效；
     pollCount=1 且 retryCount=0 = 从头到尾同一个 worker，没被重新分配。
⑤ Conductor Task Log（extendLease 下唯一的运行中进展通道）
   · [1] model · 144 tok / $0.0007
   · [3] done · 360 tok / $0.0018
```

### 逐条通过标准

| # | 看什么 | 通过标准 | 对应设计 |
|---|---|---|---|
| 1 | **运行时长 > 5 秒，但 status 是 COMPLETED 不是 TIMED_OUT** | **最关键的一条**：示例的 `responseTimeoutSeconds` 是 5 秒而模型第一步要跑 12 秒。没有 extendLease 心跳的话任务必然被判超时 —— 能跑完本身就是心跳生效的证据 | §5.2、ADR-0022 |
| 2 | **`pollCount = 1` 且 `retryCount = 0`** | 任务从头到尾没回过队列、没被重新分配 = 同一个 worker 执行到底 | §2.2、§5.3 |
| 3 | 状态轨迹里**只有 `IN_PROGRESS`**，没有 `SCHEDULED` | extendLease 不把任务写回队列（callback 模式才会出现两者交替） | §2.2 |
| 4 | **真实调用：模型 2 次 / 工具 1 次** | 一次执行只跑一遍 | §5.1 |
| 5 | `output.taskId` == 任务的 `taskId` | 运行标识就是 taskId | ADR-0020 |
| 6 | `output.usage.costUsd > 0` | 成本被记账（示例配了 pricing） | §4.3 |
| 7 | ⑤ 有日志行 | 运行中的进展通道通了 | §10.4 |

> ⑤ **为空也可能是对的**：若该部署未启用 task log 索引（`NoopIndexDAO`），
> 我们的自检会关闭这条通道并告警一次，程序会打印
> 「（空 —— 该部署可能未启用 task log 索引，属预期降级）」，
> 而终态的 `output.progress` 仍然有值。这正是 §10.4 设计的降级行为。
>
> ⚠️ **extendLease 模式下运行中看不到 `outputData`**：心跳走的是
> `updateTask({extendLease:true})`，服务端在写 `outputData` 之前就 return 了。
> 所以运行途中要看进展只能看 Task Log。这是明确接受的代价（§5.6）。

---

## 4. 在 Conductor UI 上确认

打开 <http://localhost:8080> → Executions → 选中刚才的 workflow。

| 看什么 | 通过标准 |
|---|---|
| 任务的 **Status** | 全程 `IN_PROGRESS`，最终 `COMPLETED`（不出现 `SCHEDULED`） |
| 任务的 **Poll Count** | **恒为 1** |
| 任务的 **Retry Count** | **0** |
| 任务的 **Update Time** | 运行期间每 4 秒左右刷新一次 —— 那就是心跳 |
| 任务的 **Output** | 有 `ok` / `taskId` / `result` / `progress` / `usage` |
| 任务的 **Logs** 标签 | 有若干行 `[n] phase · tok`（索引启用时） |
| Task Definitions → `agent_order_assistant` | `timeoutSeconds = 0`、`responseTimeoutSeconds = 5`、`retryCount > 0` |

---

## 5. worker 崩溃与重新分配（可选，手动）

验证「worker 半路没了，任务不会卡死」：

```bash
# 终端 A：起 worker
pnpm --filter @ca-example/minimal-agent start
# 打印出 workflowId、任务进入 IN_PROGRESS 后，立刻 Ctrl-C 杀掉终端 A

# 终端 B：起另一个 worker
pnpm --filter @ca-example/minimal-agent start
```

**通过标准**：约 5~10 秒后（`responseTimeoutSeconds` + decider 扫描延迟），
Conductor 把任务判 `TIMED_OUT` 并生成**新 taskId** 重新分配给终端 B，工作流最终 `COMPLETED`。
UI 上能看到 `Retry Count = 1`，且 Task 列表里有两条记录（原来那条是 `TIMED_OUT`）。

> ⚠️ 这里会**重复付费**：整次运行重来一遍。这是 ADR-0019 / ADR-0022 明确接受的代价，
> M2 会用实测数据决定要不要做 checkpoint。

---

## 6. 心跳配置的负向验证（可选，5 分钟）

证明「配置错了会在启动时被拒绝，而不是线上超时才发现」：

把 `examples/minimal-agent/src/agent.ts` 里的 `responseTimeoutSeconds` 改成 `1`，再启动。

**通过标准**：启动即报错，信息里说明官方 `LeaseTracker` 在间隔 < 1000ms 时会跳过心跳。

---

## 7. 并发槽占用（可选，理解容量模型）

`concurrency` 的含义在 extendLease 下是「**同时最多跑几个 agent**」，不是吞吐。
示例配的是 `concurrency: 2`，同时触发 3 个工作流：

```bash
# 触发三次（用 UI 或 curl 都行）
```

**预期**：前两个立刻进入 `IN_PROGRESS`，第三个在队列里等，直到有槽释放。
这是正常且正确的行为 —— 一次 agent 运行本来就该独占一份资源配额（§5.6）。

---

## 8. 收尾

```bash
docker compose -f examples/minimal-agent/docker-compose.yml down -v
```

---

## 验证不通过时

| 现象 | 多半是 |
|---|---|
| e2e 被跳过 | Conductor 连不上；检查 `/health` |
| 任务变成 `TIMED_OUT` | 心跳没发出去。查 `responseTimeoutSeconds` 是否 < 1.25，以及服务端是否 ≥ 3.10.7 |
| 状态轨迹里出现 `SCHEDULED` | `leaseExtendEnabled` 没生效，走了 callback 路径 |
| `pollCount > 1` 或 `retryCount > 0` | 发生过重新分配 —— worker 崩过或心跳断过，查 worker 日志 |
| 真实模型调用次数 > 2 | 任务被跑了不止一遍，检查上一条 |
| Task Log 为空 | 多半是部署未启用索引（预期降级）；确认程序是否打印了那句降级告警 |
| 运行中 `outputData` 一直是空 | **这是预期的**，见 §3 的说明 |
| 拉不到镜像 | 见 §0：`3.21.21` 没有发布镜像 |

请把实际输出贴回来，尤其是第 3 节的「运行时长 / pollCount / retryCount」三行
与第 4 节的 TaskDef 三个值 —— 如果与预期不符，那是设计或实现的真实缺陷，需要修。
