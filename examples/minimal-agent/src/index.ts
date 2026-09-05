/**
 * 示例：最小 Agent worker（lease-extend 策略）。目标里程碑 M1。
 *
 * 演示：AgentDefinition → createAgentWorker → 交给官方 TaskManager 托管，
 * 在真实 Conductor OSS 上端到端跑通；TaskDef 由 limits 自动推导
 * （responseTimeoutSeconds 设短靠心跳续租、timeoutSeconds 覆盖 wallClockMs，见 §6.6）。
 *
 * M0 骨架：待实现
 */
export {};
