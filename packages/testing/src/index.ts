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
 * - engineConformance()：对每个 AgentEngine（含用户自建）跑同一套契约测试 ——
 *   受管入口是否真的被全部调用、replay 是否幂等、suspended→恢复是否正确、
 *   **声明的 capabilities 是否与实际行为一致**（防止适配器谎报能力，§11）。
 *   既是我们的回归，也是引擎作者的验收工具
 * - sliceHarness()：sliceMs 设为极小值强制大量分片，断言结果与单片执行一致
 * - packCompatibility()：校验领域包声明的 engines 契约版本范围与引擎实际 contractVersion
 *   匹配（ADR-0017）；同时把关「改了 Pack 可见的形状必须 +1」这条纪律 ——
 *   没有它，那层版本保护就是假的
 *
 * 上游 SDK 版本策略（ADR-0017 / architecture.md §11）：不建多版本矩阵。
 * CI 只跑 latest 与 peerDependencies 下界两个版本，本套件充当 canary ——
 * 上游一旦动了适配器依赖的 3 个 API 面，它先红。
 */
export {};
