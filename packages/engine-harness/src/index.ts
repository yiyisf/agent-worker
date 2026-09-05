/**
 * @ca/engine-harness —— 适配 AI SDK 的 HarnessAgent，一次拿到 9+ 个既有 harness
 * （Claude Code / Cline / Codex / Cursor / Deep Agents / fx / Grok Build / OpenCode / Pi）。
 * 见 docs/architecture.md §4.4、ADR-0012。
 *
 * ⚠️ 能力受限，必须如实声明（这是 EngineCapabilities 存在的首要原因）：
 *
 *   state: 'engine-session'   用 harness 自己的 session resume state（detach()/stop() 返回，
 *                             未完成的 turn 含 continuation state），存入我们的 StateStore
 *   suspend: 'native-approval'
 *   interceptTools: false     ⚠️ 工具在 **sandbox 内**执行，我们拦截不到 ——
 *                             core 因此拒绝声明了 effectful 工具策略的 spec，
 *                             不能让用户误以为拿到了幂等保护
 *   granularity: 'turn'       journal 与恢复退化到 turn 级，不是 step 级
 *   interceptModel: ?         部分适配器的模型调用亦发生在 sandbox 内 ——
 *                             需逐个适配器核实并如实声明（遗留问题 3）
 *
 * 这既是限制也是收益：沙箱隔离更强，但护栏与副作用保护够不着。取舍必须写进文档。
 *
 * M0 骨架：待实现
 */
export {};
