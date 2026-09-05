# ADR-0001：Agent 推理循环放在 Worker 内闭环

- 状态：Accepted
- 日期：2026-09-05

## 背景

Agent 的 ReAct / tool-calling 循环有两种落法：
(a) 一个 Conductor task = 一次完整 Agent 运行（黑盒）；
(b) 每次 LLM 调用、每次工具调用各是一个 task，循环用 `DO_WHILE` + `SWITCH` 表达（白盒）。

## 决策

v1 采用 (a)。

## 理由

- 循环轮数与工具选择由模型在运行时决定，用 `DO_WHILE` 表达会把提示词逻辑外溢到工作流 JSON，双份真相源。
- 每步一个 task 意味着每步一次入队/出队/持久化，对 5～15 步的 Agent 是数量级的调度开销与延迟。
- 上下文（messages）需要在 task 之间传递，直接撞上 Conductor 的 payload 体积限制。
- 迭代 Agent 时不必改工作流定义，发布节奏解耦。

## 代价与缓解

- **可观测性变差**：Conductor UI 只看到一个 task。→ 用 Task Log 写步级进度、OTel 记录完整 span 树、transcript 外置可回放（§10）。
- **重试粒度粗**：失败重跑整个 Agent。→ Journaled Replay 让重跑只补做未完成的步（ADR-0003）。
- **长时任务与租约冲突**：→ ADR-0004。

## 留口

`StepExecutor` 接口把「执行一步」抽象出来，未来的 `ConductorStepExecutor` 可以把 step 下沉为 Conductor task，
在不改核心状态机的前提下支持白盒模式（路线图 M5）。
