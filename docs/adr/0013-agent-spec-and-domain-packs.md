# ADR-0013：`AgentSpec` 纯数据契约与 L0/L1/L2 领域定制

- 状态：Accepted
- 日期：2026-09-05

## 背景

目标是「通用配置化 + 定制特定领域 agent」。v0.3 的 `AgentDefinition` 是 TypeScript 对象，
含函数字段（动态 instructions、guardrail 实现），无法序列化，也就无法配置化、无法 diff、无法远程下发。

## 决策

**分离数据与实现**：

- `AgentSpec` 是**纯 JSON 数据**：引擎标识、`engineOptions`（透传给引擎的不透明原生配置）、
  `toolPolicies`（可靠性策略，按工具名）、`limits`、`guardrails` 引用、`conductor` 参数、`extends`。
- 实现（工具函数、护栏函数、prompt 正文）由**代码**提供，spec 里只放引用。

**三层组合**，后者覆盖前者：

| 层 | 内容 | 提供者 |
|---|---|---|
| L0 通用默认 | 引擎默认、限额默认、基础护栏、Conductor 参数推导 | SDK 内置 |
| L1 领域包 | 领域工具、工具策略、护栏、prompt、spec 片段、eval 数据集、领域 schema | `@acme/ca-pack-<domain>` |
| L2 实例 | 具体 agent 的 spec | 使用方 |

`SpecLoader` 负责合并（数组字段的合并策略显式声明）、JSON Schema 校验，
并输出 **effective spec 快照**写入 journal 与 `outputData`。
`ca spec diff` / `ca spec explain <field>` 支持排查。

## 理由

1. **配置化的前提是可序列化**。函数字段一旦进入契约，YAML/远程配置/灰度/审计全部做不了。
2. **`engineOptions` 保持不透明是刻意的**。试图统一各引擎的原生配置，就等于重新发明每个 SDK，
   也就回到了 ADR-0011 刚否决的路。校验交给引擎自己。
3. **effective spec 快照是配置化系统的生命线**。三层合并之后，「这次运行到底用的什么配置」
   必须可追溯，否则线上问题无法归因。
4. **领域定制需要的是打包能力，不是新抽象**。Domain Pack 复用既有扩展位
   （工具、策略、护栏、prompt），只是把它们连同 eval 数据集一起版本化分发。

## 边界

Domain Pack **不可**贡献：受管入口的实现、Journal / Fence 语义、Conductor 映射——这些是 core 的不变量。
Pack 与引擎适配器同进程运行、具备完整权限，应按依赖审计对待。

## 代价

- **动态 instructions 等能力从契约里消失**。→ 放进 `engineOptions` 或由领域包以代码提供，
  代价是这部分不可配置化，这是有意的取舍。
- **Pack 依赖引擎原生工具格式，引擎换代时会破**。→ Pack 是否需声明兼容的引擎与版本范围，M4 决定（遗留问题 5）。
