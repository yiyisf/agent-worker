/**
 * @ca/engine-ai-sdk —— 适配 Vercel AI SDK 的 ToolLoopAgent。见 docs/architecture.md §4.3、ADR-0011。
 *
 * contractVersion: 1（ADR-0017 —— 只在暴露给领域包的形状破坏性变化时 +1，与上游 ai 版本号无关）
 *
 * capabilities:
 *   runtimeLocation: 'host-process'  工具跑在本进程 → interceptTools 为 true
 *   state: 'messages'                AI SDK 的 messages 数组本身就是可序列化的跨分片状态
 *   suspend: 'native-approval'       toolApproval 的两段式审批与 Conductor callback 分片同构
 *   sliceControl: 'native'           SliceBudget 翻译成 stopWhen 自定义停止条件
 *   interceptModel: true             wrapLanguageModel 的 wrapGenerate / wrapStream
 *   interceptTools: true             包装 tool({ execute })
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
 * 分片切分（ADR-0015）：把 core 给的 SliceBudget 翻译成 stopWhen 自定义谓词
 * （墙钟 / 受管模型调用次数 / 受管工具执行次数任一耗尽即停）。stopWhen 的判定发生在
 * 「最后一步有工具结果」时 —— 正是干净边界；停下后 response.messages 直接就是可续跑的状态，
 * 返回 { kind: 'continue', state: messages }。
 *
 * 上游依赖面只有 3 处（ADR-0017 / §11）：wrapLanguageModel 中间件、包装 tool.execute、stopWhen。
 * 升级 ai 时只需盯这三处；CI 只跑 latest 与 peerDependencies 下界两个版本。
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
