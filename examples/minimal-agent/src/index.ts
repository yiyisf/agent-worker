/**
 * 示例：最小 Agent worker —— ai-sdk/tool-loop 引擎 + callback 分片。目标里程碑 M1。
 *
 * 演示：
 * - 用 AI SDK 原生写法定义 ToolLoopAgent 与 tool()，本 SDK 不发明第二套（ADR-0011）
 * - AgentSpec（纯数据）+ 引擎注册 → createAgentWorker → 官方 TaskManager 托管
 * - 模型调用经 wrapLanguageModel 中间件、工具执行经 execute 包装，全部落到受管入口（ADR-0012）
 * - 跨分片恢复：每轮结束持久化 messages → IN_PROGRESS + callbackAfterSeconds → 下次 poll 继续
 *
 * M0 骨架：待实现
 */
export {};
