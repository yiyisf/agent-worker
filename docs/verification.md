# M1 验证清单

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

- `docker-compose.yml` 默认用 **`3.22.3`**（≥ 3.21.21 的最近稳定版）。
- 要对着你自己的 3.21.21 构建验证：`CONDUCTOR_IMAGE_TAG=3.21.21 docker compose up -d`。
- 我们依赖的服务端语义（`callbackAfterSeconds`、responseTimeout 判定、
  `taskExecLogSizeLimit`、`extendLease`）都是照着 **3.21.21 的源码**核实的，
  见 [architecture.md §2.2](architecture.md#22-服务端语义v32121-源码核实结论)。
  若你在 3.22.x 上跑出与文档不符的行为，那是一条值得记录的新发现。

---

## 1. 起环境

```bash
docker compose -f examples/minimal-agent/docker-compose.yml up -d
docker compose -f examples/minimal-agent/docker-compose.yml ps
```

**预期**：三个容器 healthy（`ca-conductor`、`ca-conductor-postgres`、`ca-redis`）。
Conductor 首次启动要建表，约 60–90 秒。

```bash
curl -sf http://localhost:8080/health && echo OK
```

**通过标准**：返回 `OK`。UI 在 <http://localhost:8080>。

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

**预期**：`91 passed`（其中 3 个 e2e 用例此前会被跳过，现在应当执行）。

若看到 `Test Files 8 passed | 1 skipped`，说明 e2e 仍被跳过 ——
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
   task=IN_PROGRESS  task=IN_PROGRESS  task=COMPLETED
④ 结果
   status  = COMPLETED
   output  = {
     "answer": "订单 A-1001 已发货，预计明天送达。",
     "progress": { "phase": "done", "step": 3, "usage": {...}, "sliceIndex": 1 },
     "usage": { "inputTokens": 300, "outputTokens": 60, "costUsd": 0.0018 },
     "slices": 2
   }
   真实调用：模型 2 次 / 工具 1 次
⑤ Conductor Task Log（进展的尽力而为通道）
   · [1] model · 144 tok / $0.0007 · slice 0
   · [3] done · 360 tok / $0.0018 · slice 1
```

### 逐条通过标准

| # | 看什么 | 通过标准 | 对应设计 |
|---|---|---|---|
| 1 | `task=IN_PROGRESS` 至少出现一次 | 任务被 **callback 分片**交还过，不是一口气跑完 | §5.3、ADR-0009 |
| 2 | `slices` ≥ 2 | 跨分片恢复真的发生了（spec 里 `sliceMs: 1000` 故意切小） | ADR-0015 |
| 3 | **真实调用：模型 2 次 / 工具 1 次** | 这是最关键的一条：脚本化模型逻辑上只有两步，**无论切成几片、重放几次，真实调用次数都不变** —— 说明 journal 短路生效、没有重复付费 | ADR-0012 |
| 4 | `output.progress.step > 0` | 进展的**权威通道**可被工作流消费 | §10.4 |
| 5 | `output.usage.costUsd > 0` | 成本被记账（示例配了 pricing） | §4.3 |
| 6 | ⑤ 有日志行且形如 `[3] done · … · slice 1` | 进展的**尽力而为通道**通了；日志是一行文本，不是 payload | ADR-0018 |

> ⑤ **为空也可能是对的**：若该部署未启用 task log 索引（`NoopIndexDAO`），
> 我们的启动自检会关闭通道二并告警一次。此时程序会打印
> 「（空 —— 该部署可能未启用 task log 索引，属预期降级）」，
> 而权威通道 `output.progress` 仍然有值。这正是 §10.4 设计的降级行为。

---

## 4. 在 Conductor UI 上确认

打开 <http://localhost:8080> → Executions → 选中刚才的 workflow。

| 看什么 | 通过标准 |
|---|---|
| 任务的 **Status** 变化 | 出现过 `IN_PROGRESS`，最终 `COMPLETED` |
| 任务的 **Output** | 有 `progress` / `usage` / `slices` 字段 —— 运行中就能看到进度，不必等结束 |
| 任务的 **Logs** 标签 | 有若干行 `[n] phase · tok · slice k`（索引启用时） |
| Task Definitions → `agent_order_assistant` | `responseTimeoutSeconds = 30`、`timeoutSeconds = 144`、`retryCount > 0` |

`responseTimeoutSeconds = 30` 是 **30s 下限**生效的证据：spec 里 `sliceMs: 1000`，
按 ×3 推导本应是 3s。设小会成比例加重 decider 负载（该值同时决定 Conductor
重扫这个工作流的频率），所以被夹住了 —— 见 [architecture.md §6.6](architecture.md#66-taskdef-推导限额是唯一真相源)。

---

## 5. 崩溃恢复（可选，手动）

这一条验证「worker 半路没了，不重复付费」：

```bash
# 终端 A：起 worker
pnpm --filter @ca-example/minimal-agent start

# 在打印出 workflowId、任务进入 IN_PROGRESS 后，立刻 Ctrl-C 杀掉终端 A
# 终端 B：重新起一个 worker（同一个 Redis，因此能读到同一份 journal）
pnpm --filter @ca-example/minimal-agent start
```

**通过标准**：第二个 worker 接手后工作流能跑完，且它打印的
「真实调用：模型 N 次」**小于**逻辑总步数 —— 已完成的那些步被 journal 短路了。

> 判据不是「有没有重跑」，而是「有没有**重复付费**」。
> 恢复靠的是 journal 有没有终态条目，不是 Conductor 的 `retryCount`（ADR-0016）。

---

## 6. 收尾

```bash
docker compose -f examples/minimal-agent/docker-compose.yml down -v
```

---

## 验证不通过时

| 现象 | 多半是 |
|---|---|
| e2e 被跳过 | Conductor 或 Redis 连不上；检查 `/health` 与 `redis-cli ping` |
| `slices` 恒为 1 | `sliceMs` 被改大了，或引擎 `sliceControl` 不是 `native` |
| 真实模型调用次数 > 2 | **journal 没生效** —— 这是严重问题，检查 Redis 是否可写、`runKey` 是否稳定 |
| Task Log 为空 | 多半是部署未启用索引（预期降级）；确认程序是否打印了那句降级告警 |
| `responseTimeoutSeconds` 不是 30 | TaskDef 是旧的；`registerTask` 用的是覆盖注册，确认没有被别处改过 |
| 拉不到镜像 | 见 §0 的版本说明：`3.21.21` 没有发布镜像 |

请把实际输出贴回来，尤其是第 3 节的「真实调用」那行与第 4 节的 TaskDef 三个值 ——
如果与预期不符，那是设计或实现的真实缺陷，需要修。
