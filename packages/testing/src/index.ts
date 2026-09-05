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
 * - leaseHarness()：responseTimeoutSeconds 设为秒级 + 长任务，断言心跳生效、任务未被重投
 */
export {};
