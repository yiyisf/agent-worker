/**
 * @ca/testing —— 测试设施。见 docs/architecture.md §12。
 * 「恢复」与「并发抢占」两类测试是本 SDK 的核心资产，需在 M2 前建立。
 *
 * M0 骨架：待实现
 * - FakeConductorServer：内存队列实现 ConductorClient 的 6 个端点
 * - ScriptedModelProvider：按序返回预设响应，支持录制/回放
 * - crashAfter(seq)：在第 N 条 journal entry 后杀进程，断言恢复后无重复副作用
 * - contendRunKey()：双 worker 抢同一 runKey，断言 fence 生效且只有一次成功回写
 */
export {};
