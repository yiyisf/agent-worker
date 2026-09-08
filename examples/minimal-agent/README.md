# minimal-agent

M1 的端到端示例：一个订单助手 Agent 跑在 Conductor 的 SIMPLE 任务上。

完整的验证步骤与通过标准见 [docs/verification.md](../../docs/verification.md)。

## 快速跑一遍

对着**已在运行的** Conductor OSS（≥ 3.10.7）：

```bash
export CONDUCTOR_SERVER_URL=http://your-conductor:8080/api

pnpm --filter @ca-example/minimal-agent verify   # 一键验证，逐条 PASS/FAIL + 写出报告
pnpm --filter @ca-example/minimal-agent start    # 或者手动跑一次看过程
```

没有现成服务端的话，仓库带了个 compose：
`pnpm --filter @ca-example/minimal-agent up`，收尾 `… down`。

完整验证说明见 [docs/verification.md](../../docs/verification.md)。

## 它演示什么

| 文件 | 演示 |
|---|---|
| `src/agent.ts` | 工具与模型用 **AI SDK 原生写法**；`AgentSpec` 是纯数据，只声明可靠性策略（ADR-0011 / ADR-0013） |
| `src/conductor.ts` | 装配：`createAgentWorker` 编译出的 worker 直接交给官方 `TaskManager`（ADR-0006）。**没有任何外部中间件** |
| `src/main.ts` | 跑一次并打印状态轨迹、运行时长、`pollCount` / `retryCount`、结果与 task log |
| `src/verify.ts` | 一键验证：跑完整流程、逐条 PASS/FAIL、写出可直接贴回的报告 |
| `src/e2e.test.ts` | 端到端断言；**没有 Conductor 就跳过而不是失败** |

## 三个刻意的设计

**`responseTimeoutSeconds = 5s`，而模型第一步故意跑 12 秒。**

这是整个示例的核心（[ADR-0022](../../docs/adr/0022-lease-extend-worker-affinity.md)）：
没有 extendLease 心跳的话，任务必然在 5 秒后被判 `TIMED_OUT`。
**能跑完本身就是心跳生效的证据**，而心跳是官方 SDK 的 `LeaseTracker` 发的，我们一行没写。

同时你会看到 `pollCount = 1`、`retryCount = 0`、状态轨迹里全程 `IN_PROGRESS` 没有
`SCHEDULED` —— 这三条一起说明**任务从头到尾在同一个 worker**，从没回过队列。
生产默认 `responseTimeoutSeconds = 60`（心跳每 48 秒一次）。

**默认用脚本化的假模型。**
验证因此零成本、可重复，不需要任何 LLM key。
设了 `ANTHROPIC_API_KEY` 就自动换成真模型（走 AI SDK 的 provider 生态，我们不维护 provider 适配）。
真实性由[引擎一致性套件](../../docs/architecture.md#11-测试策略)保证，不靠这个示例。

**运行途中的进展只在 Task Log 里。**
extendLease 心跳碰不到 `outputData`（服务端在写它之前就 return 了），
所以 `outputData` 只在结束时写一次。要在运行中看进度，看任务的 Logs 标签。
这是明确接受的代价，见 [§5.6](../../docs/architecture.md#56-明确接受的两条代价)。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONDUCTOR_SERVER_URL` | `http://localhost:8080/api` | Conductor REST 根路径 |
| `CONDUCTOR_IMAGE_TAG` | `3.22.3` | compose 用的镜像 tag；**Docker Hub 上没有 3.21.21** |
| `CA_DEMO_DELAY_MS` | `12000` | 假模型第一步的人为延迟，用来让运行时长超过 `responseTimeoutSeconds` |
| `ANTHROPIC_API_KEY` | 未设 | 设了就用真模型 |
| `CA_MODEL` | `claude-sonnet-5` | 真模型时用哪个 |

> compose 里的 Redis 服务是**可选的**，只给 `BlobStore`（结果超出 outputData 预算时外置）用。
> SDK 本身不连它。
