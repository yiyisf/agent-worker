# ADR-0003：以 Journaled Replay 作为恢复机制

- 状态：Accepted
- 日期：2026-09-05

## 背景

Conductor 是 at-least-once 投递。Agent 的每一步都可能花钱（LLM）或产生副作用（工具）。
朴素重试 = 重复付费 + 重复副作用。

## 决策

Agent 循环建模为显式状态机，每一步写一条 append-only `JournalEntry`；
恢复时重放循环，命中 journal 的步直接取历史结果，不再真正执行。

`stepId = sha256(runKey | seq | kind | 归一化输入)`，同时充当 journal 主键、工具幂等键、响应缓存键。

## 备选方案

- **不做恢复，全靠 Conductor 重试**：简单，但长 Agent 重跑成本高，且无法避免重复副作用。
- **把 messages 存回 Conductor task output 再重投**：撞 payload 限制，且需要工作流配合。
- **接 Temporal 之类的持久执行引擎**：与「适配 Conductor」的项目目标冲突，引入第二个编排系统。

## 约束

重放的正确性依赖「所有非确定性都经由受管入口」（ModelRouter / ToolRegistry / ctx.now / ctx.random）。
用户在 Agent 代码里直接 `Date.now()` 或 `fetch()` 会破坏这一点。
→ 提供 lint 规则 + 运行时告警，但**不做沙箱**（作用域只在一个 task 内，收益不抵复杂度）。
