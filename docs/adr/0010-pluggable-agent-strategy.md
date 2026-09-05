# ADR-0010：可插拔的 `AgentStrategy`，决策与执行分离

- 状态：Accepted（`AgentStrategy` 接口在 v1 期间标记 experimental）
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
