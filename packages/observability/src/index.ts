/**
 * @ca/observability —— OTel GenAI span 与 Agent 语义指标。
 * 见 docs/architecture.md §10。AgentEvent 是唯一埋点数据源。
 *
 * 边界（ADR-0006）：worker 侧指标（poll 延迟、执行时长、队列滞留、心跳）直接用官方 SDK 的
 * Prometheus 采集（CanonicalMetricsCollector / MetricsServer），本包不重复实现。
 *
 * M0 骨架：待实现
 * - otelEventSink：span 树 agent.run → agent.step → gen_ai.chat / tool.execute
 * - 从任务输入的 _traceparent 继承 trace context，traceId 回写 outputData
 * - Agent 语义指标：token / cost / 步数分布 / 工具成功率 / 护栏拦截率 /
 *   恢复次数 / fence 抢占次数 / 预算触顶次数
 * - taskLogSink：经官方 getTaskContext()?.addLog() 写进度，供 Conductor UI 观察
 */
export {};
