# Conductor AI Agent Worker SDK

面向 [Conductor OSS](https://conductor-oss.org/) 的 AI Agent worker SDK：
工作流里放一个 task，背后就是一次完整的、可观测、可恢复、有预算约束的 Agent 运行。

- **语言**：TypeScript (Node.js ≥ 20)
- **执行模式**：Worker 内闭环 —— 一个 Conductor task = 一次完整 Agent 运行，循环跑在 **worker 进程内**
- **Agent 能力**：**不自建**。由外部 Agent SDK 提供（首选 [Vercel AI SDK](https://github.com/vercel/ai)），本 SDK 通过 `AgentEngine` 适配
- **默认租约**：`callback` 分片执行（Conductor 3.x 全系可用）
- **当前状态**：M0，架构设计与目录骨架（v0.4）。代码为契约声明，尚无实现。

## 这个 SDK 做什么、不做什么

```
外部 Agent SDK 负责          本 SDK 负责
─────────────────────       ─────────────────────
推理循环 / 停止条件           Journal 与崩溃恢复
上下文压缩 / 工具收窄          effectively-once（幂等 + Fencing）
工具定义 DSL                 预算治理（token / cost / 时间）
模型 provider 生态            Conductor 租约与分片执行
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
    deps.model.guard(params, async () => { /* ... */ }) },
});
const tools = mapValues(userTools, (t, name) => ({
  ...t,
  execute: (input, opts) => deps.tools.guard(name, input, () => t.execute!(input, opts)),
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

**`EngineCapabilities` 显式建模能力差异，不假装统一。** 例如 sandbox 型 harness 的工具在沙箱内执行，
我们拦截不到 → core 拒绝这类 spec 声明 `effectful` 工具策略。宣称"支持任意 SDK"却不说清能力边界，
比不支持更危险 —— 用户会误以为拿到了 effectively-once。

### 2. `AgentSpec` —— 纯 JSON 的配置化

```jsonc
{
  "name": "claims_triage",
  "extends": ["@acme/ca-pack-insurance#claimsTriageBase"],
  "engine": "ai-sdk/tool-loop",
  "engineOptions": { "model": "claude-sonnet-5", "stopWhen": { "isStepCount": 30 } },
  "toolPolicies": { "openClaim": { "effect": "effectful", "onAmbiguousReplay": "probe" } },
  "limits": { "maxCostUsd": 2, "wallClockMs": 900000 },
  "conductor": { "leaseStrategy": "callback", "domain": "insurance" }
}
```

`engineOptions` 对 core **不透明**是刻意的——统一各引擎的原生配置等于重新发明每个 SDK。

### 3. 领域定制：L0 → L1 → L2

L0 通用默认 → L1 领域包（`@acme/ca-pack-<domain>`：工具、策略、护栏、prompt、spec 片段、eval 集）
→ L2 实例 spec，逐层覆盖。合并结果输出 **effective spec 快照**写入 journal 与 `outputData`，
使「这次运行到底用的什么配置」可追溯（[ADR-0013](docs/adr/0013-agent-spec-and-domain-packs.md)）。

## Conductor 对接（v0.3 已对齐）

| 能力 | 最低版本 |
|---|---|
| `callback` 策略（默认） | 3.x 全系 |
| `lease-extend` / `hybrid` | **v3.10.7**（`TaskResult.extendLease` 自该版本引入） |

服务端租约/超时的精确语义见 [architecture.md §2.2](docs/architecture.md#22-服务端语义v32121-源码核实结论)，
三条容易踩的坑：`retryCount` 不可为 0、`timeoutSeconds` 必须覆盖所有等待时间、`timeoutPolicy` 对 responseTimeout 无效。

**`EngineTurn` 与 Conductor 分片天然同构**：引擎交还一轮 = 桥接层交还一个分片。
AI SDK 的两段式 tool approval 正好落在这个边界上，HITL 不需要任何 hack。

## 从这里开始

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 完整技术架构设计 |
| [§3.1 核心洞察](docs/architecture.md#31-核心洞察可靠性不需要拥有循环) | 为什么 core 可以这么薄 |
| [§4.4 能力边界](docs/architecture.md#44-enginecapabilities--诚实的能力边界) | 不同引擎的能力差异与校验 |
| [§7 配置化与领域定制](docs/architecture.md#7-配置化与领域定制) | L0/L1/L2 与 SpecLoader |
| [docs/adr/](docs/adr/) | 13 条决策记录（含 3 条被后续推翻/修订的） |

## 仓库结构

```
packages/  core / engine-ai-sdk / engine-harness / engine-custom
           conductor / memory / observability / testing / cli
examples/  minimal-agent (M1) / hitl-approval (M5) / domain-pack (M4)
```

## 路线图

**M1** 最小可用（core 契约 + 受管入口 + journal + callback + engine-ai-sdk，跑通 3.21.21）
→ **M2** 可靠性（fencing + 三类测试 + **引擎一致性套件**）
→ **M3** 多引擎（harness 能力降级 + custom + 能力校验）
→ **M4** 配置化与领域定制 → **M5** HITL 与生态 → **M6** 生产化

M1 只做一个引擎。**多引擎推迟到 M3**：先用一个真实引擎把契约打磨对，再谈通用——
反过来做必然设计出架空的抽象。

## 待确认

**TanStack 的定位。** 其生态（Query / Store / Router / Pacer）以前端为主，
[Pacer 官方文档](https://tanstack.com/pacer/latest/docs/overview)亦说明目前主要面向客户端，
放进 worker 运行时依赖并不合适。若目标是**运行观测台 / 人工审批界面**，
建议独立为 `@ca/console` 应用，通过 StreamSink 与 StateStore 读取，不进 worker 运行时——
请确认这个理解是否与预期一致（见 [architecture.md §15](docs/architecture.md#15-遗留问题) 遗留问题 6）。
