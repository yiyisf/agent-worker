/**
 * 示例：yield 策略 + 人工审批 + Conductor 子工作流工具。目标里程碑 M3。
 *
 * 演示：
 * - ctx.suspend() 挂起 → IN_PROGRESS + callbackAfterSeconds → 审批回调 → 从 journal 恢复（§7.4）
 * - conductorWorkflowTool 以 yield 模式等待子工作流，不占用 worker 槽位（§7.3）
 * - effectful 工具在模糊重放时走 fail + 工作流补偿分支（ADR-0005）
 *
 * M0 骨架：待实现
 */
export {};
