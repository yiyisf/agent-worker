/**
 * @ca/engine-harness —— 适配 AI SDK 的 HarnessAgent，一次拿到 9+ 个既有 harness
 * （Claude Code / Cline / Codex / Cursor / Deep Agents / fx / Grok Build / OpenCode / Pi）。
 * 见 docs/architecture.md §4.4、ADR-0012。
 *
 * ⚠️ 能力按适配器逐个不同，必须如实声明（这是 EngineCapabilities 存在的首要原因）。
 * interceptTools 不靠逐个试，由运行位置机械推导：interceptTools = (runtimeLocation === 'host-process')
 *
 * 按 AI SDK 官方 adapter capability 表整理（architecture.md §4.4，随上游更新时同步）：
 *
 *   适配器         运行位置          interceptTools  原生审批  结构化输出
 *   ───────────────────────────────────────────────────────────────────
 *   Cline          host process      true            true      true
 *   Pi             host process      true            true      false
 *   Claude Code    sandbox bridge    false           true      true
 *   Deep Agents    sandbox bridge    false           true      true
 *   OpenCode       sandbox bridge    false           true      true
 *   Codex          sandbox bridge    false           **false** true     ← suspend: 'none'，不支持 HITL
 *   Cursor         sandbox via ACP   false           true      false
 *   fx             sandbox via ACP   false           true      false
 *   Grok Build     sandbox via ACP   false           true      true
 *
 * 共同项：
 *   state: 'engine-session'   用 harness 自己的 session resume state（detach()/stop() 返回，
 *                             未完成的 turn 含 continuation state），存入我们的 StateStore
 *   sliceControl: 'none'      一个 turn 不可中途拆分 → 一轮 = 一分片
 *   granularity: 'turn'       journal 与恢复退化到 turn 级，不是 step 级
 *
 * ⚠️ interceptModel 尚未确认（architecture.md §15.3 第 1 条）：
 * 上表只说明了**工具**的运行位置，没说**模型调用**在哪发起。sandbox bridge 型很可能也在沙箱内 ——
 * 若如此则 interceptModel: false，会直接触发 core 的拒绝启动规则，本包将无法纳入预算治理。
 * M3 前必须逐个适配器实测出结论。
 *
 * 沙箱隔离更强，但护栏与副作用保护够不着 —— 这个取舍必须写进面向用户的文档。
 *
 * M0 骨架：待实现
 */
export {};
