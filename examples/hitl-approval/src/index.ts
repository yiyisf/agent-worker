/**
 * 示例：native-approval 挂起 → Conductor callback 分片的同构映射。目标里程碑 M5。
 *
 * 演示：
 * - AI SDK 的 toolApproval 两段式审批天然落在 Conductor 分片边界上，不需要任何 hack（§4.7 A）：
 *     generate() 返回 tool-approval-request → EngineTurn { kind:'suspended' }
 *       → 持久化 messages 到 StateStore → IN_PROGRESS + callbackAfterSeconds 交还任务（释放槽位）
 *       → 审批系统写回决定 → 下次 poll 追加 tool-approval-response → 再跑一轮
 * - ⚠️ timeoutSeconds 必须覆盖「所有分片执行 + 所有等待」的总和，长审批要相应放大（§6.6、§2.2）
 * - effectful 工具在模糊重放时走 fail + 工作流补偿分支（ADR-0005）
 *
 * M0 骨架：待实现
 */
export {};
