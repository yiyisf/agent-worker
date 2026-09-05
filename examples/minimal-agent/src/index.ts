/**
 * 示例：最小 Agent worker —— react 策略 + callback 租约（v0.3 默认路径）。目标里程碑 M1。
 *
 * 演示：AgentDefinition → createAgentWorker → 交给官方 TaskManager 托管，
 * 在 Conductor OSS 3.21.21 上端到端跑通，并覆盖跨分片恢复
 * （每片写 journal → IN_PROGRESS + callbackAfterSeconds 交还 → 下次 poll 从 journal 继续）。
 *
 * M0 骨架：待实现
 */
export {};
