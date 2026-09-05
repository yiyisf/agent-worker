/**
 * 示例：plan-execute 策略 + 人工审批 + Conductor 子工作流工具。目标里程碑 M4。
 *
 * 演示：
 * - 自定义策略只返回 StepPlan，由 Runtime 执行并写 journal（ADR-0010）
 * - ctx.suspend() → setCallbackAfter(n) → 审批回调写 StateStore → 下次 poll 从 journal 恢复（§7.4）
 *   ⚠️ timeoutSeconds 必须覆盖「所有分片执行 + 所有等待」的总和，长审批要相应放大（§6.6）
 * - conductorWorkflowTool 以 callback 模式等待子工作流，不占用 worker 槽位（§7.3）
 * - effectful 工具在模糊重放时走 fail + 工作流补偿分支（ADR-0005）
 *
 * M0 骨架：待实现
 */
export {};
