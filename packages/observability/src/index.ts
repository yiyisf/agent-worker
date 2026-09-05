/**
 * @ca/observability —— OpenTelemetry 接线、指标与日志。
 * 见 docs/architecture.md §10。AgentEvent 是唯一埋点数据源。
 *
 * M0 骨架：待实现
 * - otelEventSink：span 树 agent.run → agent.step → gen_ai.chat / tool.execute
 * - 从任务输入的 _traceparent 继承 trace context，traceId 回写 outputData
 * - 指标：runs / 延迟 / token / cost / 工具成功率 / 恢复次数 / 租约丢失 / poll 空转率
 * - conductorLogSink：关键节点写 Task Log，供 Conductor UI 直接观察进度
 */
export {};
