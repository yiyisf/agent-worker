# ADR-0005：effectful 工具在模糊重放时默认失败，而非重试

- 状态：Accepted（2026-10-09 补充佐证，见下文；在 Pi Durable 引擎上的落实见 [ADR-0026](0026-pi-durable-engine-spike.md)）
- 日期：2026-09-05

## 背景

崩溃恢复时可能出现：journal 里只有 `tool.intent` 而没有 `tool.result`。
即「工具执行到一半进程没了，无法判断外部副作用是否已经发生」。

## 决策

工具用 `effect: 'pure' | 'idempotent' | 'effectful'` 声明契约。
`effectful` 工具遇到上述模糊态时，默认 `onAmbiguousReplay: 'fail'`：
整个 task 以 `FAILED_WITH_TERMINAL_ERROR` 结束，由工作流的补偿分支接管。

可选 `'retry'`（调用方自证可重复）与 `'probe'`（工具实现 `probe(idempotencyKey)` 查询是否已生效）。

## 理由

「静默重复一次支付/发货/发邮件」的代价，远高于「让工作流走一次补偿分支」。
Conductor 的编排能力恰好擅长表达补偿，把决策交还给工作流是更合适的分工。

**另一种做法是把「被中断」交给模型自己判断**（Pi Durable 对 `replay: "unsafe"` 工具的缺省行为）。
第三方实测（2026-10）给出了反例：在 Gmail 写草稿的工具执行中途杀掉进程，恢复后
Claude Sonnet 拒绝重试，Claude Haiku 却重试了，留下两份草稿，还回报「已保存一份」。
模型能否正确处理模糊态取决于具体模型，不能作为可靠性机制。这支持本 ADR 的选择：
模糊态交给工作流的补偿分支，不交给模型。

## 代价

- 不声明 `effect` 的工具默认按 `pure` 处理，可能被错误重放。
  → 未声明时发出运行时告警；`strictEffects: true` 配置下拒绝注册未声明 `effect` 的工具。
