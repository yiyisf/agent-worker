# Conductor AI Agent Worker SDK

面向 [Conductor OSS](https://conductor-oss.org/) 的 AI Agent worker SDK：
工作流里放一个 task，背后就是一次完整的、可观测、可恢复、有预算约束的 Agent 运行。

- **语言**：TypeScript (Node.js ≥ 20)
- **执行模式**：一个 Conductor task = 一次完整 Agent 运行。`execute()` 把 agent 从头跑到完，
  **官方 SDK 的 `LeaseTracker` 自动发 extendLease 心跳**，任务从头到尾在同一个 worker
  （[ADR-0022](docs/adr/0022-lease-extend-worker-affinity.md)）
- **Agent 能力**：**不自建**。由外部 Agent SDK 提供（基线 [`ai@7.x`](https://github.com/vercel/ai)），本 SDK 通过 `AgentEngine` 适配
- **外部依赖**：**零**。不需要 Redis 或任何中间件 —— agent 状态全程在 worker 进程内
- **服务端要求**：Conductor OSS **≥ 3.10.7**（`TaskResult.extendLease` 自该版本引入）
- **当前状态**：**M1 代码完成**（v0.8 设计）。79 个离线测试通过；端到端验证待真机执行，见 [docs/verification.md](docs/verification.md)

## 这个 SDK 做什么、不做什么

```
外部 Agent SDK 负责          本 SDK 负责
─────────────────────       ─────────────────────
推理循环 / 停止条件           预算治理（token / cost / 时间）
上下文压缩 / 工具收窄          超时闸门与工具幂等键
工具定义 DSL                 运行态输入输出与结果映射
模型 provider 生态            payload 外置与取消检测
MCP 客户端                   进展反馈与 OTel GenAI 埋点
结构化输出                   配置化（AgentSpec）与领域定制
既有 harness 适配             能力边界校验（诚实的降级）
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
  "conductor": { "responseTimeoutSeconds": 60, "domain": "insurance" }
}
```

`engineOptions` 对 core **不透明**是刻意的——统一各引擎的原生配置等于重新发明每个 SDK。

### 3. 领域定制：L0 → L1 → L2

L0 通用默认 → L1 领域包（`@acme/ca-pack-<domain>`：工具、策略、护栏、prompt、spec 片段、eval 集）
→ L2 实例 spec，逐层覆盖。合并结果输出 **effective spec 快照**写入 journal 与 `outputData`，
使「这次运行到底用的什么配置」可追溯（[ADR-0013](docs/adr/0013-agent-spec-and-domain-packs.md)）。

## Conductor 对接

`execute()` 就是把 agent 从头跑到完：

```
poll → 任务被 ack 从队列删除，只属于这个 worker
     → execute() 里 runAgent()，跑多久都行
       官方 LeaseTracker 同时按 responseTimeoutSeconds × 0.8 自动发 extendLease 心跳
     → 返回终态

worker 崩了 → 没人心跳 → responseTimeout 后判 TIMED_OUT
            → 消耗一次 retryCount → 新 taskId 重新分配给别的 worker
```

**「一次执行始终在同一 worker」是引擎保证的**，不是我们实现的：

```java
// ExecutionService.poll 的最后一行
tasks.forEach(this::ackTaskReceived);
// → queueDAO.ack → DELETE FROM queue_message
```

poll 成功后任务就不在队列里了，别的 worker 根本看不到它。`extendLease` 只刷
`updateTime`、不碰队列，所以任务一直归当前 worker；而 `callback` 每次交还都
`postpone` 写回队列，下次谁 `pop` 到就是谁 —— 亲和随之丢失。

服务端语义见 [architecture.md §2.2](docs/architecture.md#22-服务端语义v32121-源码核实结论)，
三条最容易踩的坑（都经 3.21.21 源码核实）：

1. **`responseTimeoutSeconds < 1.25` 会让官方心跳静默失效** —— `LeaseTracker` 算出的
   间隔 < 1000ms 时直接 return 不发心跳，任务必然被判超时。SDK 启动时拒绝这种配置。
2. **`extendLease` 碰不到 `outputData`** —— 服务端在写 `outputData` 之前就 return 了。
   所以运行途中的进展只能走 Task Log（`addTaskLog` 不碰队列）。
3. **`inputData` 在一个 task 实例内是冻结的** —— 外部信号无法在运行途中送达；
   长等待（人工审批）应该交给工作流的 HUMAN 任务，而不是让 agent 自己等。

前两条不检查的话，线上表现都是「agent 莫名其妙超时」，很难查。所以有一个
**启动自检**（[§6.8](docs/architecture.md#68-启动自检preflight)）把它们挡在启动阶段：

```ts
await preflight({ taskDefs, source: httpPreflightSource({ serverUrl }), logger: console });
// 服务端 < 3.10.7 → 拒绝启动
// 线上 responseTimeoutSeconds < 1.25 或 retryCount = 0 → 拒绝启动
// 其余 TaskDef 漂移 → 告警
```

它挡的最要紧的一类是「**代码是对的，线上定义被人改坏了**」——
`LeaseTracker` 读的是运行态任务上的快照值，线上被调小心跳就静默失效了。

## 从这里开始

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 完整技术架构设计 |
| [§3.1 两条核心洞察](docs/architecture.md#31-两条核心洞察) | 为什么 core 可以这么薄，以及为什么 agent 不该被塞进任务窗口 |
| [§5 执行模型](docs/architecture.md#5-执行模型) | extendLease 心跳、运行身份、两条明确接受的代价 |
| [§4.4 能力边界](docs/architecture.md#44-enginecapabilities--诚实的能力边界) | 不同引擎的能力差异与校验 |
| [§7 配置化与领域定制](docs/architecture.md#7-配置化与领域定制) | L0/L1/L2、SpecLoader、引擎契约版本 |
| [§10.4 进展反馈](docs/architecture.md#104-进展反馈让编排引擎在运行中就知道进度) | 运行中的进展同步回编排引擎（不是实时输出流） |
| [§15 遗留问题](docs/architecture.md#15-遗留问题) | 已关闭 9 条、已定方案 3 条、仍开放 3 条 |
| [docs/adr/](docs/adr/) | 22 条决策记录 —— 被推翻的都保留原文并写清推翻的理由，**包括我们自己核实错的那一条**（ADR-0019 的 60 秒 unack 窗口） |
| [docs/verification.md](docs/verification.md) | M1 端到端验证清单：命令、预期输出、通过标准 |

## 仓库结构

```
packages/  core / engine-ai-sdk / engine-harness / engine-custom
           conductor / memory / observability / testing / cli
examples/  minimal-agent (M1) / hitl-approval (M5) / domain-pack (M4)
```

## 路线图

**M1** ✅ 代码完成（core 执行内核 + engine-ai-sdk + extendLease 桥接 + 进展反馈 + 示例）
→ **M2** 可靠性加固（崩溃重分配验证 + 大输入取回 + 长任务压测 + 「要不要做 checkpoint」的实测决策）
→ **M3** 多引擎（harness 能力降级 + custom + 能力校验）
→ **M4** 配置化与领域定制 → **M5** HITL 与生态 → **M6** 生产化

M1 只做一个引擎。**多引擎推迟到 M3**：先用一个真实引擎把契约打磨对，再谈通用——
反过来做必然设计出架空的抽象。

## 已定案：TanStack 现阶段不纳入

其生态（Query / Store / Router / Pacer）以前端为主，
[Pacer 官方文档](https://tanstack.com/pacer/latest/docs/overview)亦说明目前主要面向客户端，
不适合进 worker 运行时依赖。将来若需要**运行观测台 / 人工审批界面**，
独立为 `@ca/console` 应用，通过 StreamSink 与 Conductor 自身的 API 读取，与 worker 运行时解耦。

## 本地开发

```bash
pnpm install
pnpm build          # 包之间按拓扑顺序构建；子包 typecheck 依赖 core 的构建产物
pnpm test           # 83 个测试（无 Conductor 时自动跳过端到端用例）
```

**SDK 本身不需要 Redis。** 只有可选的 `BlobStore`（结果超出 outputData 预算时外置）
用得上它，对应的测试没有 Redis 会跳过而不是失败：

```bash
redis-server --port 6380 --daemonize yes --save '' --appendonly no
CA_TEST_REDIS_URL=redis://127.0.0.1:6380 pnpm test
```

对着**已在运行的** Conductor OSS（≥ 3.10.7）做端到端验证：

```bash
export CONDUCTOR_SERVER_URL=http://your-conductor:8080/api

pnpm --filter @ca-example/minimal-agent verify   # 一键验证：逐条 PASS/FAIL + 写出报告
CONDUCTOR_SERVER_URL=$CONDUCTOR_SERVER_URL pnpm test   # 或跑完整测试套件
```

不需要 Redis、不需要 LLM key（示例默认用确定性的脚本化模型）。
完整说明与通过标准见 **[docs/verification.md](docs/verification.md)**。

## 文档校验

架构图是 mermaid，肉眼评审抓不住语法问题（`subgraph` 标题含全角括号必须加引号）。
校验命令：

```bash
npm run docs:check-mermaid    # 渲染 docs/ 下所有 mermaid 块，失败即报错
```
