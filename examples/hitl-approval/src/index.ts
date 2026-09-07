/**
 * 示例：等待人工审批的 Agent。目标里程碑 M5。
 *
 * 异步化之后（ADR-0019）这件事变得很简单：agent 在后台跑，**它本来就可以等**。
 *
 * M1 就能用的做法 —— 把等待放进工具里（§4.7）：
 *
 *     tool({
 *       execute: async (input, { idempotencyKey }) => {
 *         const ticket = await approvals.create(input, idempotencyKey);
 *         await approvals.waitUntilDecided(ticket);   // ← 等多久都行
 *         if (!ticket.approved) throw new CaError('审批被拒', false);
 *         return refunds.execute(input, { idempotencyKey });
 *       },
 *     })
 *
 * 期间：受管工具入口按 ToolPolicy.timeoutMs 计时（长审批要放大或设 0），
 * 后台宿主照常心跳，execute() 照常回执 IN_PROGRESS，工作流在 UI 上看得到
 * 「还活着、停在 tool:requestRefund」。等待期**不占任何 worker 并发槽**。
 *
 * M5 要补的是引擎级的两段式审批（capabilities.suspend = 'native-approval'）：
 * AI SDK 的 toolApproval 让 generate() 返回 tool-approval-request 并结束本轮，
 * 需要适配器在 run 内部接住、等决定、再继续。**这完全是适配器内部的事**，
 * 桥接层不参与 —— 与 v0.6 把挂起做成 Conductor 交还有本质区别。
 *
 * ⚠️ 不要试图「交还任务 + 等外部把决定写回 inputData」：核实过 inputData 在一个
 * task 实例的生命周期内是**冻结的**（updateTask 从不碰它），决定根本送不进来。
 *
 * M0 骨架：待实现
 */
export {};
