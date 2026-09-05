/**
 * @ca/providers-anthropic —— Claude 模型适配器（ModelProvider 实现）。
 * 见 docs/architecture.md §8。默认推荐 claude-opus-5 / claude-sonnet-5。
 *
 * M0 骨架：待实现
 * - 统一 Message/Part ↔ Anthropic wire format 互转（含 thinking block、并行 tool call）
 * - stop reason 归一化、usage 与成本核算
 * - prompt cache 提示透传、AbortSignal 贯通、流式 delta
 */
export {};
