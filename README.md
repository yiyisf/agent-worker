# Conductor AI Agent Worker SDK

面向 [Conductor OSS](https://conductor-oss.org/) 的 AI Agent worker SDK：
工作流里放一个 task，背后就是一次完整的、可观测、可恢复、有预算约束的 Agent 运行。

- **语言**：TypeScript (Node.js ≥ 20)
- **执行模式**：**异步化** —— 一个 Conductor task = 一次完整 Agent 运行的**观察句柄**；
  `execute()` 毫秒级返回，agent 在后台跑完后直接把任务推向终态（[ADR-0019](docs/adr/0019-async-agent-execution.md)）
- **Agent 能力**：**不自建**。由外部 Agent SDK 提供（基线 [`ai@7.x`](https://github.com/vercel/ai)），本 SDK 通过 `AgentEngine` 适配
- **对接方式**：`callback` 心跳（Conductor 3.x 全系可用），不用 `extendLease`、不做分片
- **当前状态**：**M1 代码完成**（v0.7 设计）。73 个离线测试通过；端到端验证待真机执行，见 [docs/verification.md](docs/verification.md)

## 这个 SDK 做什么、不做什么

```
外部 Agent SDK 负责          本 SDK 负责
─────────────────────       ─────────────────────
推理循环 / 停止条件           异步执行与失联接管
上下文压缩 / 工具收窄          预算治理（token / cost / 时间）
工具定义 DSL                 超时闸门与工具幂等键
模型 provider 生态            Conductor callback 协议
MCP 客户端                   结果映射与 payload 治理
结构化输出                   OTel GenAI 埋点与成本归集
既有 harness 适配             配置化（AgentSpec）与领域定制
```

核心洞察：**可靠性不需要拥有循环，只需要拦截两个入口** —— 模型调用（决定成本）
与工具执行（决定副作用）。循环的其余部分既不花钱也无副作用，没有拦截价值。
于是 `@ca/core` 只需提供两个 `guard` 函数，任何 Agent SDK 都能在几十行内适配
（[ADR-0012](docs/adr/0012-reliability-by-interception.md)）。

```ts
// 引擎适配器的全部义务：让调用经过受管入口
const model = wrapLanguageModel({          // AI SDK 中间件
  model: userModel,
  middleware: { wrapGenerate: ({ doGenerate, params }) =>
    gateways.model.guard(params, async () => { /* ... */ }) },
});
const tools = mapValues(userTools, (t, name) => ({
  ...t,
  execute: (input, opts) => gateways.tools.guard(name, input,
    ({ idempotencyKey }) => t.execute!(input, { ...opts, idempotencyKey })),
}));
```

## 三层设计

### 1. `AgentEngine` —— 适配任意 Agent SDK

契约只有 3 个成员（`capabilities` / `build` / `run`）。首批适配：

| 引擎 | 覆盖 |
|---|---|
| `@ca/engine-ai-sdk` | AI SDK `ToolLoopAgent`（`stopWhen` / `prepareStep` / `toolApproval` / provider 生态 / `@ai-sdk/mcp`） |
| `@ca/engine-harness` | AI SDK `HarnessAgent` → Claude Code / Cline / Codex / Cursor / Deep Agents / fx / Grok Build / OpenCode / Pi |
| `@ca/engine-custom` | 最小手写循环参考实现，兼作一致性测试基线 |

**`EngineCapabilities` 显式建模能力差异，不假装统一。** 两个关键分级：

- `costVisibility`：`ai-sdk/tool-loop` 是 `per-call`（每次模型调用都拦得到）；
  **所有 harness 适配器都是 `per-turn`** —— `HarnessAgent` 的 `model` 是 harness 专属字符串，
  不存在可包装的模型对象，与沙箱无关。预算因此降级为轮间闸门。
- `toolInterception`：harness 一律 `host-declared-only` —— 我们传进去的工具拦得到，
  它自带的内建工具拦不到，`effectful` 声明在内建工具上会被启动时拒绝。

宣称"支持任意 SDK"却不说清能力边界，比不支持更危险 —— 用户会误以为拿到了调用级成本管控。

### 2. `AgentSpec` —— 纯 JSON 的配置化

```jsonc
{
  "name": "claims_triage",
  "extends": ["@acme/ca-pack-insurance#claimsTriageBase"],
  "engine": "ai-sdk/tool-loop",
  "engineOptions": { "model": "claude-sonnet-5", "stopWhen": { "isStepCount": 30 } },
  "toolPolicies": { "openClaim": { "effect": "effectful", "timeoutMs": 120000 } },
  "limits": { "maxCostUsd": 2, "wallClockMs": 900000 },
  "conductor": { "callbackAfterSeconds": 30, "domain": "insurance" }
}
```

`engineOptions` 对 core **不透明**是刻意的——统一各引擎的原生配置等于重新发明每个 SDK。

### 3. 领域定制：L0 → L1 → L2

L0 通用默认 → L1 领域包（`@acme/ca-pack-<domain>`：工具、策略、护栏、prompt、spec 片段、eval 集）
→ L2 实例 spec，逐层覆盖。合并结果输出 **effective spec 快照**写入 journal 与 `outputData`，
使「这次运行到底用的什么配置」可追溯（[ADR-0013](docs/adr/0013-agent-spec-and-domain-packs.md)）。

## Conductor 对接

`execute()` 只回答一个问题：**这个 taskId 的运行现在怎么样了？**

```
poll → execute(task)                    ← 毫秒级返回，从不阻塞
         ├─ 没有这个运行 → 后台起一个 → IN_PROGRESS + callbackAfterSeconds
         ├─ 正在跑       → IN_PROGRESS（带进展）
         ├─ 已完成       → COMPLETED / FAILED
         └─ 宿主失联     → 接管重跑（不消耗 Conductor 重试配额）

后台运行结束 → 直接 updateTask(COMPLETED)，不等下一次 callback
```

**运行的身份就是 `taskId`**：同一次执行的多次 callback 共享它，重试则是新的
（[ADR-0020](docs/adr/0020-runid-is-taskid.md)）。不需要自己拼恢复锚点。

服务端语义见 [architecture.md §2.2](docs/architecture.md#22-服务端语义v32121-源码核实结论)，
三条最容易踩的坑（都经 3.21.21 源码核实）：

1. **队列有 60 秒 unack 窗口，硬编码不可配** —— worker 持有任务超过它，
   消息会被放回队列被别人并发取走。这是 `execute()` 必须毫秒返回的硬理由。
2. **`IN_PROGRESS` 回执会被存成 `SCHEDULED`**，所以等待期间 `responseTimeout` 根本不参与判定。
3. **`inputData` 在一个 task 实例内是冻结的** —— 外部信号无法在 callback 等待期间送达。

## 从这里开始

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 完整技术架构设计 |
| [§3.1 两条核心洞察](docs/architecture.md#31-两条核心洞察) | 为什么 core 可以这么薄，以及为什么 agent 不该被塞进任务窗口 |
| [§5 执行模型](docs/architecture.md#5-执行模型) | callback 协议、运行注册表、失联接管 |
| [§4.4 能力边界](docs/architecture.md#44-enginecapabilities--诚实的能力边界) | 不同引擎的能力差异与校验 |
| [§7 配置化与领域定制](docs/architecture.md#7-配置化与领域定制) | L0/L1/L2、SpecLoader、引擎契约版本 |
| [§10.4 进展反馈](docs/architecture.md#104-进展反馈让编排引擎在运行中就知道进度) | 运行中的进展同步回编排引擎（不是实时输出流） |
| [§15 遗留问题](docs/architecture.md#15-遗留问题) | 已关闭 10 条、已定方案 3 条、仍开放 3 条 |
| [docs/adr/](docs/adr/) | 21 条决策记录（v0.7 推翻了其中 7 条、修订 2 条 —— 每条都写清了推翻的理由） |
| [docs/verification.md](docs/verification.md) | M1 端到端验证清单：命令、预期输出、通过标准 |

## 仓库结构

```
packages/  core / engine-ai-sdk / engine-harness / engine-custom
           conductor / memory / observability / testing / cli
examples/  minimal-agent (M1) / hitl-approval (M5) / domain-pack (M4)
```

## 路线图

**M1** ✅ 代码完成（core 异步执行内核 + 运行注册表 + engine-ai-sdk + Conductor callback 协议 + 进展反馈 + 示例）
→ **M2** 可靠性加固（失联/并发注入 + 大输入取回 + 「要不要把 journal 加回来」的实测决策）
→ **M3** 多引擎（harness 能力降级 + custom + 能力校验）
→ **M4** 配置化与领域定制 → **M5** HITL 与生态 → **M6** 生产化

M1 只做一个引擎。**多引擎推迟到 M3**：先用一个真实引擎把契约打磨对，再谈通用——
反过来做必然设计出架空的抽象。

## 已定案：TanStack 现阶段不纳入

其生态（Query / Store / Router / Pacer）以前端为主，
[Pacer 官方文档](https://tanstack.com/pacer/latest/docs/overview)亦说明目前主要面向客户端，
不适合进 worker 运行时依赖。将来若需要**运行观测台 / 人工审批界面**，
独立为 `@ca/console` 应用，通过 StreamSink 与运行注册表读取，与 worker 运行时解耦。

## 本地开发

```bash
pnpm install
pnpm build          # 包之间按拓扑顺序构建；子包 typecheck 依赖 core 的构建产物
pnpm test           # 76 个测试（无 Redis / Conductor 时自动跳过需要它们的用例）

# 需要 Redis 的用例（注册表一致性套件、端到端）
# 没有 Redis 时会**跳过而不是失败** —— 纯逻辑部分任何机器上都能跑
redis-server --port 6380 --daemonize yes --save '' --appendonly no
pnpm test
```

`CA_TEST_REDIS_URL` 可覆盖默认的 `redis://127.0.0.1:6380`。

跑端到端（需要 docker daemon）：

```bash
docker compose -f examples/minimal-agent/docker-compose.yml up -d
CONDUCTOR_SERVER_URL=http://localhost:8080/api pnpm test
pnpm --filter @ca-example/minimal-agent start   # 手动跑一次并看输出
```

完整的验证清单与通过标准见 **[docs/verification.md](docs/verification.md)**。

## 文档校验

架构图是 mermaid，肉眼评审抓不住语法问题（`subgraph` 标题含全角括号必须加引号）。
校验命令：

```bash
npm run docs:check-mermaid    # 渲染 docs/ 下所有 mermaid 块，失败即报错
```
