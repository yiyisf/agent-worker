/**
 * 示例：需要人工审批的 Agent。目标里程碑 M5。
 *
 * extendLease 下 agent 独占一个 worker 直到跑完，所以「等」的成本是明确的：
 * **占着一个并发槽**。据此按时长分两档（§4.7）。
 *
 * ── 短等待（秒级到分钟级）：工具内 await ──
 *
 *     tool({
 *       execute: async (input, { idempotencyKey }) => {
 *         const job = await vendor.submit(input, idempotencyKey);
 *         return vendor.waitUntilDone(job);       // 就在这等
 *       },
 *     })
 *
 * 期间受管工具入口按 ToolPolicy.timeoutMs 计时，官方 LeaseTracker 照常发心跳，
 * 任务在 Conductor UI 上一直是 IN_PROGRESS。
 *
 * ── 长等待（人工审批、跨天）：交给工作流，别让 agent 等 ──
 *
 *   agent_审核(判断该不该退款)  →  HUMAN(人工审批)  →  agent_执行退款
 *           ↓ COMPLETED                                      ↑
 *           outputData = { ok: false, awaiting: {            │
 *             kind: 'approval', reason: '金额超限',           │
 *             proposal: { orderId, amount } } } ─── SWITCH ──┘
 *
 * SDK 提供的是「agent 能返回一个结构化的**需要人来定**结果」，复用 §6.2 已有的
 * 「做不到但流程该继续」映射（COMPLETED + ok:false）。
 *
 * 为什么不让 agent 自己等几天：占着并发槽不放；wallClockMs 得设成天级、
 * 超时保护形同虚设；worker 一挂等待连同整次运行全丢。
 * **该编排的事交给编排引擎，别在一个 task 里造迷你工作流。**
 *
 * ⚠️ 不要试图「交还任务 + 等外部把决定写回 inputData」：核实过 inputData 在一个
 * task 实例的生命周期内是**冻结的**（updateTask 从不碰它），决定根本送不进来。
 *
 * M0 骨架：待实现
 */
export {};
