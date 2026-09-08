# M1 验证说明

对着**你已在运行的 Conductor OSS** 验证本 SDK。不涉及如何部署引擎。

> 本项目的开发环境没有 docker daemon，所以真实 Conductor 上的验证只能在你的机器上做。
> 下面每一步都给了命令、预期、以及「看到什么才算通过」。

## 0. 前置

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20，pnpm 9 |
| Conductor OSS | **≥ 3.10.7** —— `TaskResult.extendLease` 自该版本引入，本 SDK 依赖它 |
| 网络 | 能访问 Conductor 的 REST 根路径（形如 `http://host:8080/api`） |
| Redis / LLM key | **都不需要**。SDK 默认零外部依赖；示例默认用确定性的脚本化模型，验证零成本、可重复 |

```bash
export CONDUCTOR_SERVER_URL=http://your-conductor:8080/api
```

后面所有命令都假设设了这个变量（不设则默认 `http://localhost:8080/api`）。

**验证会往你的 Conductor 写这两条元数据**（覆盖注册，可重复执行）：

| 类型 | 名字 |
|---|---|
| TaskDef | `agent_order_assistant` |
| WorkflowDef | `minimal_agent_demo` (version 1) |

跑完想清理：`DELETE /api/metadata/taskdefs/agent_order_assistant` 与
`DELETE /api/metadata/workflow/minimal_agent_demo/1`。

---

## 1. 一键验证（推荐，约 1 分钟）

```bash
pnpm install
pnpm build
pnpm --filter @ca-example/minimal-agent verify
```

它会跑完整流程并逐条打 ✅ / ❌，最后写出 `examples/minimal-agent/verification-report.md`。
**把那个文件贴回来就行**，不用手动比对输出。全通过退出码 0，有失败非 0（可直接进 CI）。

输出形如：

```
验证目标：http://your-conductor:8080/api
────────────────────────────────────────────────────────────────────────

✅ S1  服务端可达且能读到版本
      实测：version = 3.21.21
✅ P1  启动自检：服务端支持 extendLease
      实测：extendLeaseSupported = true
✅ P2  启动自检：线上 TaskDef 与本地推导零漂移
      实测：无漂移
✅ T1  timeoutSeconds = 0（长任务不设总时长上限）
      实测：timeoutSeconds = 0
✅ R2  ⭐ 运行时长 > responseTimeoutSeconds 却没被判超时 → **心跳生效**
      实测：运行 12.4s vs responseTimeout 5s，任务状态 COMPLETED
✅ R3  ⭐ pollCount = 1 且 retryCount = 0 → **从头到尾同一个 worker**
      实测：pollCount = 1, retryCount = 0
✅ R5  ⭐ 一次执行只跑一遍：模型 2 次 / 工具 1 次
      实测：模型 2 次 / 工具 1 次
…
全部 15 项通过。
报告已写入：…/verification-report.md
```

### 三条加 ⭐ 的是本次验证的核心

| 检查 | 它在证明什么 | 不通过说明 |
|---|---|---|
| **R2** 运行 12 秒 > `responseTimeoutSeconds` 5 秒，任务仍是 `COMPLETED` | **extendLease 心跳真的在发** —— 示例故意让模型第一步跑 12 秒，没有心跳的话必然被判 `TIMED_OUT` | `leaseExtendEnabled` 没生效，或服务端不支持 extendLease |
| **R3** `pollCount = 1`、`retryCount = 0` | **一次执行始终在同一个 worker** —— 任务 poll 后被 `ack` 从队列删除，没回过队列 | 中途发生过重新分配，查 worker 日志 |
| **R5** 模型 2 次 / 工具 1 次 | 一次执行只跑一遍，没有重复付费 | 任务被跑了不止一遍，多半是上一条的连带 |

其余检查覆盖：启动自检（extendLease 版本、TaskDef 漂移）、TaskDef 注册值、
`outputData` 的形状、`taskId` 一致性、成本记账、Task Log 通道。

---

## 2. 跑测试套件（可选，约 30 秒）

```bash
pnpm test
```

**预期**：`79 passed | 4 skipped` —— 4 个 e2e 用例需要 Conductor。带上服务端地址：

```bash
CONDUCTOR_SERVER_URL=$CONDUCTOR_SERVER_URL pnpm test
```

此时应为 `83 passed`。

> 另有 2 个 `@ca/memory` 的用例需要 Redis（只测可选的 `BlobStore`）。没有 Redis 会跳过而不是失败；
> 想跑就 `redis-server --port 6380 --daemonize yes` 后加 `CA_TEST_REDIS_URL=redis://127.0.0.1:6380`。

---

## 3. 手动跑一次看输出（可选）

一键脚本已经覆盖了断言。想亲眼看看过程：

```bash
pnpm --filter @ca-example/minimal-agent start
```

关键行：

```
① 注册 TaskDef 与工作流定义…
② 启动自检（服务端版本 / TaskDef 漂移）…
   服务端 3.21.21 · extendLease 可用 · 漂移 0 项
③ 启动 worker（poll 循环与 extendLease 心跳都由官方 SDK 托管）…
   [order_assistant] extendLease 心跳：每 4s 一次（responseTimeoutSeconds=5），由官方 LeaseTracker 托管
④ 触发一次运行…
   任务状态轨迹： IN_PROGRESS(poll=1) → IN_PROGRESS(poll=1) → … → COMPLETED(poll=1)
⑤ 结果
   运行时长 = 12.3s（responseTimeoutSeconds = 5s）
   pollCount = 1 / retryCount = 0
   真实调用：模型 2 次 / 工具 1 次
⑥ Conductor Task Log（extendLease 下唯一的运行中进展通道）
   · [1] model · 144 tok / $0.0007
   · [3] done · 360 tok / $0.0018
```

> ⑥ **为空也可能是对的**：部署没启用 task log 索引（`NoopIndexDAO`）时日志会被静默丢弃。
> 我们在第一次写入后会**读回来实测**，发现是空的就关闭通道并告警一次。
> 终态的 `output.progress` 仍然有值 —— 这是 §10.4 设计的降级行为。
>
> ⚠️ **运行途中看不到 `outputData`**：extendLease 心跳走
> `updateTask({extendLease:true})`，服务端在写 `outputData` 之前就 return 了。
> 所以运行中要看进展只能看 Task Log。这是明确接受的代价（§5.6）。

---

## 4. 在 Conductor UI 上确认（可选）

Executions → 选中刚才的 workflow：

| 看什么 | 通过标准 |
|---|---|
| 任务的 **Status** | 全程 `IN_PROGRESS`，最终 `COMPLETED`（**不出现 `SCHEDULED`**） |
| 任务的 **Poll Count** | **恒为 1** |
| 任务的 **Retry Count** | **0** |
| 任务的 **Update Time** | 运行期间每 4 秒左右刷新一次 —— 那就是心跳 |
| 任务的 **Output** | 有 `ok` / `taskId` / `result` / `progress` / `usage` |
| Task Definitions → `agent_order_assistant` | `timeoutSeconds = 0`、`responseTimeoutSeconds = 5`、`retryCount > 0` |

---

## 5. worker 崩溃与重新分配（可选，手动，约 2 分钟）

验证「worker 半路没了，任务不会卡死」：

```bash
# 终端 A
pnpm --filter @ca-example/minimal-agent start
# 打印出 workflowId、任务进入 IN_PROGRESS 后，立刻 Ctrl-C 杀掉

# 终端 B
pnpm --filter @ca-example/minimal-agent start
```

**通过标准**：约 5~10 秒后（`responseTimeoutSeconds` + decider 扫描延迟），
Conductor 把任务判 `TIMED_OUT`、生成**新 taskId** 重新分配给终端 B，工作流最终 `COMPLETED`。
UI 上 `Retry Count = 1`，Task 列表里有两条记录（旧的那条是 `TIMED_OUT`）。

> ⚠️ 这里会**重复付费**：整次运行重来一遍。这是 ADR-0022 明确接受的代价，
> M2 会用实测数据决定要不要做 checkpoint（§15.3 第 1 条）。

---

## 6. 启动自检的负向验证（可选，约 5 分钟）

证明「配置错了会在**启动时**被拒绝，而不是线上超时才发现」。三个场景，
第二个最要紧 —— **代码是对的，线上定义被人改坏了**。

**6.1 本地取值错误**

把 `examples/minimal-agent/src/agent.ts` 里的 `responseTimeoutSeconds` 改成 `1`，再启动。

**通过标准**：启动即报错，说明官方 `LeaseTracker` 在间隔 < 1000ms 时会跳过心跳。

**6.2 线上 TaskDef 被改坏**（代码不动）

```bash
curl -s "$CONDUCTOR_SERVER_URL/metadata/taskdefs/agent_order_assistant" \
  | jq '.responseTimeoutSeconds = 1' \
  | curl -s -X PUT "$CONDUCTOR_SERVER_URL/metadata/taskdefs" \
      -H 'content-type: application/json' -d @-

pnpm --filter @ca-example/minimal-agent verify
```

**通过标准**：`P2` / `P3` 变红，报错信息里包含「静默跳过心跳」，进程非 0 退出。

不检查的话线上表现就是「agent 莫名其妙超时」，很难查 ——
因为 `LeaseTracker` 读的是**运行态任务上的快照值**，本地代码怎么看都是对的。

改回去：重跑一次 `pnpm --filter @ca-example/minimal-agent verify`（`registerMetadata` 是覆盖注册）。

**6.3 服务端版本不够**（若手上有 < 3.10.7 的实例）

```bash
CONDUCTOR_SERVER_URL=http://old-conductor:8080/api \
  pnpm --filter @ca-example/minimal-agent verify
```

**通过标准**：`P1` 变红，说明需要 ≥ 3.10.7 以及为什么。

---

## 7. 并发槽占用（可选，理解容量模型）

extendLease 下 `concurrency` 是「**同时最多跑几个 agent**」，不是吞吐 ——
一个长跑 agent 占住一个槽的全程。示例配的是 `concurrency: 2`。

一个终端起 worker，另一个终端连发三次：

```bash
pnpm --filter @ca-example/minimal-agent start     # 终端 A，保持运行

for i in 1 2 3; do                                 # 终端 B
  curl -s -X POST "$CONDUCTOR_SERVER_URL/workflow/minimal_agent_demo?version=1" \
    -H 'content-type: application/json' \
    -d '{"question":"查一下订单 A-1001 到哪了"}'
  echo
done
```

**预期**：前两个立刻进入 `IN_PROGRESS`，第三个在队列里等，直到有槽释放。
这是正常且正确的行为 —— 一次 agent 运行本来就该独占一份资源配额（§5.6）。

---

## 手上没有现成 Conductor 时

仓库里带了一个 compose（Conductor + Postgres，postgres 变体、不需要 Elasticsearch）：

```bash
pnpm --filter @ca-example/minimal-agent up      # docker compose up -d
# …验证…
pnpm --filter @ca-example/minimal-agent down
```

⚠️ Docker Hub 上**没有 `3.21.21` 这个 tag**（3.21.x 只有 `3.21.24-rc.1`，最近的稳定版是 `3.22.x`），
compose 默认用 `3.22.3`；`CONDUCTOR_IMAGE_TAG=… ` 可指向自建镜像。

---

## 验证不通过时

| 现象 | 多半是 |
|---|---|
| `S1` 失败 | `CONDUCTOR_SERVER_URL` 不对，或 `/admin/config` 被关掉了（后者只影响版本检查，不影响其余） |
| `P1` 失败 | 服务端 < 3.10.7，没有 `extendLease`。本 SDK 依赖它保证「一次执行在同一 worker」 |
| `P2` 有漂移 | 线上 TaskDef 被别处改过。报告里会列出具体字段与两边的值 |
| **`R2` 失败**（任务变成 `TIMED_OUT`） | 心跳没发出去。先看 `P1` / `T2` —— 自检就是为这个场景设计的。都 OK 却仍超时，查 worker 日志里有没有心跳失败 |
| **`R3` 失败**（`pollCount > 1` 或 `retryCount > 0`） | 中途发生过重新分配。多半是 worker 崩过、或网络断开导致心跳失败 |
| `R4` 出现 `SCHEDULED` | `leaseExtendEnabled` 没生效，走成了 callback 路径 |
| **`R5` 调用次数 > 2** | 任务被跑了不止一遍，通常是 `R3` 的连带后果 |
| `L1` 是 SKIP | 部署未启用 task log 索引（`NoopIndexDAO`），**预期降级**，不算失败 |
| 运行中 `outputData` 一直是空 | **这是预期的**，见 §3 的说明 |

把 `examples/minimal-agent/verification-report.md` 贴回来即可 ——
里面已经包含了每一项的实测值与本次运行的完整 output。
