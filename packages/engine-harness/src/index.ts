/**
 * @ca/engine-harness —— 适配 AI SDK 的 HarnessAgent，一次拿到 9 个既有 harness
 * （Claude Code / Cline / Codex / Cursor / Deep Agents / fx / Grok Build / OpenCode / Pi）。
 * 见 docs/architecture.md §4.4、ADR-0012。
 *
 * 上游基线：**ai@^7.0.0** + @ai-sdk/harness + 对应 harness 适配器 + sandbox provider。
 *
 * ⚠️ 两条能力限制是结构性的，必须如实声明 —— 这是 EngineCapabilities 存在的首要原因。
 *
 * 一、costVisibility: 'per-turn' —— 模型调用**全部**拦不到，且与沙箱无关
 *
 *   HarnessAgent({ harness, model: 'claude-sonnet-4-6', sandbox, ... }) 的 model 是一个
 *   **harness 专属的字符串标识符**，不是 AI SDK 的 LanguageModel 对象。官方原话：
 *   「The AI SDK harness abstraction is separate from the provider/model abstraction」、
 *   「Set model to select the model that the harness runtime uses」。
 *   所以根本没有可供 wrapLanguageModel 包装的对象 —— 9 个适配器一律拦不到，
 *   连 host-process 的 Cline、Pi 也不例外。问题不在沙箱，在于模型调用整体归 harness 所有。
 *
 *   好消息：适配器会把 result.usage 归一化成 AI SDK 的形状，因此 turn 级记账可行 →
 *   预算改为**轮间闸门**（跑完一轮结账，超预算就不发起下一轮）。
 *   ⚠️ 敞口：单轮内烧掉多少不可控，见 architecture.md §15.3 第 2 条。
 *
 * 二、toolInterception: 'host-declared-only' —— 工具按来源分，不是一个布尔量
 *
 *   内建工具（读写文件、跑命令）      harness 运行时自己执行  → 拦不到
 *   host-declared 工具（我们传的 tool()）「HarnessAgent executes the tool in your host」→ 拦得到
 *
 *   因此 effectful 策略**只能声明在 host-declared 工具上**，声明在内建工具上会被启动时拒绝。
 *   内建工具的副作用防护只能依赖 harness 自己的 approval 机制与沙箱隔离 ——
 *   我们不提供，也不假装提供。
 *
 * 适配器能力表（依据 ai@7.0.93，随上游更新时同步）：
 *
 *   适配器        工具运行位置      原生审批  结构化输出
 *   ─────────────────────────────────────────────────
 *   Cline         host process      true      true
 *   Pi            host process      true      false
 *   Claude Code   sandbox bridge    true      true
 *   Deep Agents   sandbox bridge    true      true
 *   OpenCode      sandbox bridge    true      true
 *   Codex         sandbox bridge    **false** true      ← suspend: 'none'，不支持 HITL
 *   Cursor        sandbox via ACP   true      false
 *   fx            sandbox via ACP   true      false
 *   Grok Build    sandbox via ACP   true      true
 *
 * 共同项：
 *   costVisibility: 'per-turn'
 *   toolInterception: 'host-declared-only'
 *   state: 'engine-session'   用 harness 的 session resume state（detach()/stop() 返回，
 *                             未完成的 turn 含 continuation state）；避免重复付费由它负责，
 *                             不是我们的 journal
 *   sliceControl: 'none'      一个 turn 不可中途拆分 → 一轮 = 一分片
 *   granularity: 'turn'
 *   progress: 'turn'          进展粒度只到 turn；适配器可把 lifecycle callbacks 与 stream 里的
 *                             tool-call 事件翻译成 phase（§10.4）——注意是翻译成进展，
 *                             不是把输出流转发给 Conductor
 *
 * 沙箱隔离更强，但护栏、幂等与调用级成本管控够不着 —— 这个取舍必须写进面向用户的文档。
 *
 * M0 骨架：待实现
 */
export {}
