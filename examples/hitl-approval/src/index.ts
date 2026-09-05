/**
 * 示例：hybrid 策略 + 人工审批 + Conductor 子工作流工具。目标里程碑 M3。
 *
 * 演示：
 * - 计算期由官方 extendLease 心跳保活；进入等待态切 callback 交还任务、释放槽位（ADR-0007）
 * - ctx.suspend() → setCallbackAfter(n) → 审批回调 → 从 journal 恢复（§7.4）
 *   注意 n 必须小于 TaskDef.timeoutSeconds，否则任务被判 TIMED_OUT
 * - conductorWorkflowTool 以 callback 模式等待子工作流，不占用 worker 槽位（§7.3）
 * - effectful 工具在模糊重放时走 fail + 工作流补偿分支（ADR-0005）
 *
 * M0 骨架：待实现
 */
export {};
