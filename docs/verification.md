# M1 验证清单（v0.7 异步化模型）

> 这一步需要在**你的机器上**执行：本项目的开发环境没有 docker daemon，
> 所以真实 Conductor 上的验证无法在这里完成。下面每一条都给了命令、预期输出、
> 以及「看到什么才算通过」。

## 0. 先决条件

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 20、pnpm 9 | `pnpm install` |
| Docker（带 daemon） | 起 Conductor 与 Redis |
| LLM key | **不需要**。示例默认用确定性的脚本化模型，验证零成本、可重复 |

### ⚠️ 关于 Conductor 镜像版本

**Docker Hub 上没有 `3.21.21` 这个 tag。** `conductoross/conductor` 的 3.21.x 只发布了
`3.21.24-rc.1`，最近的已发布稳定版是 `3.22.x`。

- `docker-compose.yml` 默认用 **`3.22.3`**。
- 要对着你自己的 3.21.21 构建验证：`CONDUCTOR_IMAGE_TAG=3.21.21 docker compose up -d`。
- 我们依赖的服务端语义都是照着 **3.21.21 的源码**核实的，
  见 [architecture.md §2.2](architecture.md#22-服务端语义v32121-源码核实结论)。
  若你在 3.22.x 上跑出与文档不符的行为，那是一条值得记录的新发现。

---

## 1. 起环境

```bash
docker compose -f examples/minimal-agent/docker-compose.yml up -d
docker compose -f examples/minimal-agent/docker-compose.yml ps
curl -sf http://localhost:8080/health && echo OK
```

**预期**：三个容器 healthy（`ca-conductor`、`ca-conductor-postgres`、`ca-redis`）；
`curl` 返回 `OK`。Conductor 首次启动要建表，约 60–90 秒。UI 在 <http://localhost:8080>。

> compose 选的是 **postgres 变体**（`CONFIG_PROP=config-postgres.properties`）：
> 不需要 Elasticsearch，且它的 `conductor.indexing.type=postgres` 意味着
> **task log 照样能存** —— §10.4 的通道二可以被真正验证到。

---

## 2. 跑单元与集成测试

```bash
pnpm install
pnpm build
CONDUCTOR_SERVER_URL=http://localhost:8080/api \
CA_TEST_REDIS_URL=redis://127.0.0.1:6380 \
pnpm test
```

**预期**：`76 passed`（其中 3 个 e2e 用例此前会被跳过，现在应当执行）。

若看到 `Test Files 11 passed | 1 skipped`，说明 e2e 仍被跳过 ——
检查 `curl http://localhost:8080/health` 与 `redis-cli -p 6380 ping`。

---

## 3. 手动跑一次，看真实输出

```bash
pnpm --filter @ca-example/minimal-agent start
```

**预期输出**（关键行）：

```
① 注册 TaskDef 与工作流定义…
② 启动 worker（poll 循环由官方 TaskManager 托管）…
③ 触发一次运行…
   workflowId = <uuid>
   任务状态轨迹： SCHEDULED(poll=1) → IN_PROGRESS(poll=2) → SCHEDULED(poll=2) → COMPLETED(poll=3)
④ 结果
   status  = COMPLETED
   output  = {
     "answer": "订单 A-1001 已发货，预计明天送达。",
     "progress": { "phase": "done", "step": 3, "usage": {...} },
     "usage": { "tokens": 360, "costUsd": 0.0018 },
     "runId": "<taskId>"
   }
   真实调用：模型 2 次 / 工具 1 次
   （无论被 callback 几次，这两个数都只反映**一次**完整运行）
⑤ Conductor Task Log（进展的尽力而为通道）
   · [1] model · 144 tok / $0.0007
   · [3] done · 360 tok / $0.0018
```

### 逐条通过标准

| # | 看什么 | 通过标准 | 对应设计 |
|---|---|---|---|
| 1 | 任务状态轨迹里 `poll=` 出现过 **> 1** | 同一个 taskId 被**多次 callback** 取回过 —— 说明 `execute()` 没有阻塞，agent 在后台跑 | §5.2、ADR-0019 |
| 2 | **真实调用：模型 2 次 / 工具 1 次** | 最关键的一条：脚本化模型逻辑上只有两步，**无论被 callback 几次，真实调用次数都不变** —— 说明注册表的原子占位生效，没有重复发起 | §5.4、ADR-0020 |
| 3 | `output.runId` == 任务的 `taskId` | 运行标识就是 taskId | ADR-0020 |
| 4 | `output.progress.step > 0` | 进展的**权威通道**可被工作流消费 | §10.4 |
| 5 | `output.usage.costUsd > 0` | 成本被记账（示例配了 pricing） | §4.3 |
| 6 | ⑤ 有日志行且形如 `[3] done · …` | 进展的**尽力而为通道**通了；日志是一行文本，不是 payload | ADR-0018 |

> ⑤ **为空也可能是对的**：若该部署未启用 task log 索引（`NoopIndexDAO`），
> 我们的自检会关闭通道二并告警一次，程序会打印
> 「（空 —— 该部署可能未启用 task log 索引，属预期降级）」，
> 而权威通道 `output.progress` 仍然有值。这正是 §10.4 设计的降级行为。

> **状态轨迹里看到 `SCHEDULED` 是正常的，不是异常。** 源码核实：worker 回执 `IN_PROGRESS`
> 时服务端会把 SIMPLE 任务的状态**实际存成 `SCHEDULED`**
> （`WorkflowExecutorOps.updateTask`）。轨迹里 `IN_PROGRESS` 与 `SCHEDULED` 交替出现，
> 分别对应「正被某个 worker 持有」与「在队列里等下一次 callback」。

---

## 4. 在 Conductor UI 上确认

打开 <http://localhost:8080> → Executions → 选中刚才的 workflow。

| 看什么 | 通过标准 |
|---|---|
| 任务的 **Status** 变化 | 出现过 `SCHEDULED` / `IN_PROGRESS`，最终 `COMPLETED` |
| 任务的 **Poll Count** | **> 1** —— 同一次执行被多次 callback |
| 任务的 **Output** | 有 `status` / `runId` / `progress` / `usage` —— 运行中就能看到进度，不必等结束 |
| 任务的 **Logs** 标签 | 有若干行 `[n] phase · tok`（索引启用时） |
| Task Definitions → `agent_order_assistant` | `timeoutSeconds = 0`、`responseTimeoutSeconds = 3600`、`retryCount > 0` |

`timeoutSeconds = 0` 是**长任务不设总时长上限**的证据（`checkTaskTimeout` 首行即
`<= 0 → return`）；`responseTimeoutSeconds` 保持服务端默认 3600 是**刻意不调小** ——
调小会抢在队列 60 秒 unack 之前把任务判 `TIMED_OUT` 并消耗一次 `retryCount`。
见 [architecture.md §6.6](architecture.md#66-taskdef-推导注册期只写不读)。

---

## 5. 宿主失联与接管（可选，手动）

这一条验证「跑 agent 的进程半路没了，任务不会卡死」：

```bash
# 终端 A：起 worker
pnpm --filter @ca-example/minimal-agent start

# 打印出 workflowId、任务进入 IN_PROGRESS 后，立刻 Ctrl-C 杀掉终端 A
# 等约 20 秒（示例的 orphanAfterMs），再起终端 B
pnpm --filter @ca-example/minimal-agent start
```

**通过标准**：第二个 worker 接手后工作流能跑完，且它的日志里有一行

```
[order_assistant] <taskId> 接管孤儿运行（第 2 次）：上一个宿主超过 20000ms 无心跳。整次运行将重新开始。
```

`output.attempts` 应为 `2`，而任务的 `retryCount` 仍为 **0** ——
接管**不消耗 Conductor 的重试配额**（ADR-0021）。

> ⚠️ 这里会**重复付费**：整次运行重来一遍，已完成的模型调用要重新付钱。
> 这是 ADR-0019 删除 journal 明确接受的代价，M2 会用实测数据决定要不要把 journal 加回来。

---

## 6. 并发接管（可选，进阶）

验证「两个 worker 实例同时 poll 到同一个任务时，只有一个会真的发起运行」：

```bash
# 两个终端各起一个 worker（共享同一个 Redis 注册表）
pnpm --filter @ca-example/minimal-agent start   # 终端 A
pnpm --filter @ca-example/minimal-agent start   # 终端 B
```

**通过标准**：两边的「真实调用：模型 N 次」加起来仍然是 **2 次**，不是 4 次。
其中一个进程会打印它拿到了所有权，另一个只会不断回执 `IN_PROGRESS`。

若加起来是 4 次，说明注册表没用共享实现 —— 检查 Redis 是否连上
（连不上时程序会打印「退回单进程内存注册表」的告警）。

---

## 7. 收尾

```bash
docker compose -f examples/minimal-agent/docker-compose.yml down -v
```

---

## 验证不通过时

| 现象 | 多半是 |
|---|---|
| e2e 被跳过 | Conductor 或 Redis 连不上；检查 `/health` 与 `redis-cli ping` |
| `pollCount` 恒为 1 | 运行太快，一次 callback 内就跑完了。把 `CA_DEMO_DELAY_MS` 调大 |
| 真实模型调用次数 > 2 | **注册表没生效** —— 这是严重问题，检查 Redis 是否可写、`runId` 是否等于 `taskId` |
| Task Log 为空 | 多半是部署未启用索引（预期降级）；确认程序是否打印了那句降级告警 |
| `timeoutSeconds` 不是 0 | TaskDef 是旧的；`registerTask` 用的是覆盖注册，确认没有被别处改过 |
| 任务长期停在 `SCHEDULED` 不动 | 后台运行挂了但心跳还在，或 `updateTask` 一直失败。查 worker 日志里的 `主动回执失败` |
| 拉不到镜像 | 见 §0 的版本说明：`3.21.21` 没有发布镜像 |

请把实际输出贴回来，尤其是第 3 节的「真实调用」那行、任务的 `pollCount`、
以及第 4 节的 TaskDef 三个值 —— 如果与预期不符，那是设计或实现的真实缺陷，需要修。
