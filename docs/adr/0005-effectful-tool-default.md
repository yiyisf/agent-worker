# ADR-0005：effectful 工具在模糊重放时默认失败，而非重试

- 状态：Accepted
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

## 代价

- 不声明 `effect` 的工具默认按 `pure` 处理，可能被错误重放。
  → 未声明时发出运行时告警；`strictEffects: true` 配置下拒绝注册未声明 `effect` 的工具。
