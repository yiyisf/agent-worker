/**
 * @ca/engine-ai-sdk —— 适配 Vercel AI SDK 的 ToolLoopAgent。见 docs/architecture.md §4.3、ADR-0011。
 *
 * capabilities:
 *   state: 'messages'            AI SDK 的 messages 数组本身就是可序列化的跨分片状态
 *   suspend: 'native-approval'   toolApproval 的两段式审批与 Conductor callback 分片同构
 *   interceptModel: true         wrapLanguageModel 的 wrapGenerate / wrapStream
 *   interceptTools: true         包装 tool({ execute })
 *   granularity: 'step'
 *
 * 适配要点（M1 实现）：
 *
 *   const model = wrapLanguageModel({
 *     model: userModel,
 *     middleware: {
 *       wrapGenerate: ({ doGenerate, params }) =>
 *         deps.model.guard(params, async () => {
 *           const r = await doGenerate();
 *           return { result: r, usage: toUsage(r.usage) };
 *         }),
 *     },
 *   });
 *
 *   const tools = mapValues(userTools, (t, name) => ({
 *     ...t,
 *     execute: (input, opts) => deps.tools.guard(name, input, () => t.execute!(input, opts)),
 *   }));
 *
 * 分片切分：用 stopWhen 注入基于 sliceMs / 调用计数的停止条件，让引擎在分片预算耗尽时
 * 返回 { kind: 'continue', state: messages }（遗留问题 1，M1 验证）。
 *
 * 挂起：result.content 中的 tool-approval-request → { kind: 'suspended', state: messages, awaiting }；
 * 恢复时把 tool-approval-response 追加进 messages 再跑一轮。
 *
 * 上下文压缩、工具收窄、动态模型选择一律交给 AI SDK 的 prepareStep / pruneMessages / activeTools，
 * 本包不重复实现。
 *
 * M0 骨架：待实现
 */
export {};
