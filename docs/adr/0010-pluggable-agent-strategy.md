# ADR-0010：可插拔的 `AgentStrategy`，决策与执行分离

- 状态：**Superseded by [ADR-0011](0011-agent-engine-over-strategy.md)**（2026-09-05）
- 日期：2026-09-05

## 背景

项目目标是**通用、可扩展、面向多场景**的 Agent 运行时。v0.2 的核心循环把 ReAct 硬编码成状态机，
这让「抽取类任务」（一次调用就够）、「计划执行类」（先规划后执行）、「反思类」（产出-自评-修订）
都得削足适履，与目标矛盾。

## 决策

把推理循环抽成 `AgentStrategy` 扩展点，**策略只做决策，不做执行**：

```ts
interface AgentStrategy<S = unknown> {
  name: string;
  init(def, input, ctx): Promise<S>;
  next(state: S, ctx): Promise<StepPlan>;      // 返回意图
  reduce(state: S, outcome: StepOutcome): S;   // 纯函数
  finalize(state: S, ctx): Promise<unknown>;
}

type StepPlan =
  | { kind: 'model';   request: ModelRequest }
  | { kind: 'tools';   calls: ToolCall[]; parallel?: boolean }
  | { kind: 'suspend'; req: SuspendRequest }
  | { kind: 'done';    output: unknown };
```

Runtime 负责执行 `StepPlan`、写 journal、做幂等、扣预算、跑护栏、记 span。
内置策略：`react`（默认）/ `plan-execute` / `reflect` / `single-shot` / `router`。

## 理由

**分离带来的核心收益：任何自定义策略都零成本继承全部可靠性机制。**

如果允许策略自己 `await model.generate()` / `await tool.execute()`，那么崩溃恢复、幂等、
预算、护栏、trace 就都得靠策略作者自觉——等于把 SDK 最难的部分外包给了扩展点的使用者，
而这些正是「自己写个 while 循环」做不好、也是本 SDK 存在的理由。

返回意图的写法还顺带保证了 ADR-0003 要求的「非确定性只经受管入口」——
策略拿不到直接调用 LLM 的句柄，就不会破坏重放。

## 状态恢复的两种模式

`callback` 分片与崩溃恢复都需要重建策略状态 `S`：

- `replay`（默认）：要求 `init` / `reduce` 是纯函数，`S` 由 journal 重放重建，无额外存储。
- `snapshot`：`S` 需可 JSON 序列化，每步写一条 `snapshot` entry。适合 `reduce` 昂贵的策略。

## 代价

- **策略作者要习惯「返回意图而不是 await 结果」**，心智负担高于直接写循环。
  → 用内置 5 个策略作为范例；`@ca/testing` 导出策略一致性测试套件（`reduce` 纯函数性、
  replay 幂等、suspend/resume 正确性），既是我们的回归，也是插件作者的验收工具。
- **接口可能不够用**：多 Agent 协作、流式中途干预等形态未必能用当前 `StepPlan` 表达。
  → v1 期间标记 `experimental`，允许 minor 破坏；需要至少 2 个真实第三方策略验证后再转 stable。

---

## 推翻原因（2026-09-05）

本 ADR 打算自研循环范式契约并内置 5 种策略。核查 Vercel AI SDK 后确认，这 5 种范式
以及配套能力（停止条件、上下文压缩、工具收窄、动态模型、结构化输出、HITL 审批、
provider 生态、MCP、以及 9+ 个既有 harness 的适配）它已全部覆盖，且更成熟。

这是本项目第三次出现「先自建、后发现生态已有」（前两次是 ADR-0002 与 ADR-0004）。
改为 [ADR-0011](0011-agent-engine-over-strategy.md) 的 `AgentEngine` 适配契约。

**保留并强化的部分**：本 ADR 最有价值的洞察是「决策与执行分离，使自定义扩展零成本继承
全部可靠性机制」。[ADR-0012](0012-reliability-by-interception.md) 把它推得更远——
可靠性根本不需要拥有循环，只需要拦截模型与工具两个入口。
`snapshot` / `replay` 两种状态恢复模式也保留，进入 `EngineCapabilities.state`。
