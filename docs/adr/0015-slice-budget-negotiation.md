# ADR-0015：分片边界由 core 给预算、引擎翻译成原生停止条件

- 状态：Accepted
- 日期：2026-09-05

## 背景

默认 `callback` 策略下，Agent 不一次跑完，而是跑一段就把任务交还 Conductor（释放 worker 槽位），
下次 poll 接着跑。问题是：**「一段」由谁喊停？**

## 备选方案

| 做法 | 问题 |
|---|---|
| core 掐表强行打断引擎 | 相当于别人跑步时把他拽住 —— 引擎内部状态处于中间态，存不下来也续不上 |
| 引擎自由裁量 | 各引擎标准不一，成本与时间无法统一治理，`limits` 形同虚设 |
| **core 给预算，引擎翻译** | ✅ 采纳 |

## 决策

core 向引擎传 `SliceBudget`，引擎适配器负责翻译成引擎原生的停止条件：

```ts
interface SliceBudget {
  wallClockMs: number;    // 默认 limits.sliceMs（60s）
  maxModelCalls: number;  // 本分片最多几次受管模型调用
  maxToolCalls: number;   // 本分片最多几次受管工具执行
}
```

新增能力位 `sliceControl: 'native' | 'none'`：

- `'native'`：引擎能接受预算并在干净的边界停下。AI SDK 的 `stopWhen` 支持自定义谓词，
  且判定发生在「最后一步有工具结果」时 —— 正是干净边界；停下后 `response.messages` 直接可续跑。
- `'none'`：引擎的一轮不可中途拆分（如 harness 的一个 turn）。此时**一轮 = 一分片**，
  由 turn 的自然边界决定，`SliceBudget` 仅作为超限告警依据，不强制。

## 理由

分片的意义是"长任务不长期霸占 worker 槽位"，这要求停在**引擎自己认可的干净点**上。
只有引擎知道哪里是干净点，所以判断交给引擎；但预算必须由 core 统一给，
否则 `limits.sliceMs` / `maxCostUsd` 这类治理就落不了地。

## 代价与遗留

`sliceControl: 'none'` 的引擎，分片时长完全由引擎决定 —— 若单个 turn 跑 20 分钟，
我们既停不了它也无法提前预知，只能事后发现总时长超了 `timeoutSeconds`。
处理方案见 architecture.md §15.3 第 2 条（倾向：spec 显式声明"允许长 turn" + 相应放大 `timeoutSeconds`），
M3 随 harness 适配一起定。
