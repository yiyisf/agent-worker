# minimal-agent

M1 的端到端示例：一个订单助手 Agent 跑在 Conductor 的 SIMPLE 任务上。

完整的验证步骤与通过标准见 [docs/verification.md](../../docs/verification.md)。

## 快速跑一遍

```bash
docker compose -f docker-compose.yml up -d          # Conductor + Postgres + Redis
pnpm --filter @ca-example/minimal-agent start        # 注册 → 起 worker → 触发一次运行
```

`docker compose down -v` 收尾。

## 它演示什么

| 文件 | 演示 |
|---|---|
| `src/agent.ts` | 工具与模型用 **AI SDK 原生写法**；`AgentSpec` 是纯数据，只声明可靠性策略（ADR-0011 / ADR-0013） |
| `src/conductor.ts` | 装配：`createAgentWorker` 编译出的 worker 直接交给官方 `TaskManager`（ADR-0006） |
| `src/main.ts` | 跑一次并打印结果、用量、进展与 task log |
| `src/e2e.test.ts` | 端到端断言；**没有 Conductor 就跳过而不是失败** |

## 两个刻意的设计

**默认用脚本化的假模型。** 验证因此零成本、可重复，不需要任何 LLM key。
设了 `ANTHROPIC_API_KEY` 就自动换成真模型（走 AI SDK 的 provider 生态，我们不维护 provider 适配）。
真实性由 [引擎一致性套件](../../docs/architecture.md#11-测试策略)保证，不靠这个示例。

**`sliceMs` 故意设成 1 秒。** 这个两步的 Agent 因此会被切成多片，
你能直接观察到 callback 分片交还、跨分片恢复、以及「无论切几片，真实模型调用次数不变」。
生产默认是 60 秒。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CONDUCTOR_SERVER_URL` | `http://localhost:8080/api` | Conductor REST 根路径 |
| `CA_TEST_REDIS_URL` | `redis://127.0.0.1:6380` | StateStore（journal / 租约 / fencing） |
| `CONDUCTOR_IMAGE_TAG` | `3.22.3` | compose 用的镜像 tag；**Docker Hub 上没有 3.21.21** |
| `ANTHROPIC_API_KEY` | 未设 | 设了就用真模型 |
| `CA_MODEL` | `claude-sonnet-5` | 真模型时用哪个 |
