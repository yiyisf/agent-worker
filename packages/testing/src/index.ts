/**
 * @ca/testing —— 测试设施。见 docs/architecture.md §12。
 * 「恢复」「并发」「租约」三类测试是本 SDK 的核心资产，需在 M2 前建立。
 *
 * 边界（ADR-0006）：传输层不再自持，v0.1 计划的 FakeConductorServer 已取消 ——
 * 集成测试直接打 docker-compose 起的真实 Conductor OSS，配合官方 TaskManager。
 *
 * M0 骨架：待实现
 * - ScriptedModelProvider：按序返回预设响应，支持录制/回放（核心单测不需要官方 SDK）
 * - crashAfter(seq)：在第 N 条 journal entry 后杀进程，断言恢复后无重复副作用
 * - contendRunKey()：双 worker 抢同一 runKey，断言 fence 生效且只有一次成功回写
 * - strategyConformance()：对每个 AgentStrategy（含用户自定义）跑同一套契约测试 ——
 *   reduce 纯函数性、replay 幂等、suspend/resume 正确性。既是我们的回归，也是插件作者的验收工具
 * - sliceHarness()：leaseSliceMs 设为极小值强制大量分片，断言结果与单片执行一致
 */
export {};
