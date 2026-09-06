/**
 * @ca/testing —— 测试设施。见 docs/architecture.md §11。
 *
 * 「引擎一致性」「恢复」「并发」「分片」是本 SDK 的核心测试资产。
 * 其中一致性套件把「支持任意 SDK」从口号变成可验证的契约 ——
 * 尤其是「声明的 capabilities 与实际行为一致」这一条。
 *
 * 已实现：checkEngineConformance、checkStateStoreConformance
 * 待实现（M2）：崩溃注入 crashAfter / 并发抢占 contendRunKey / 进展节流 progressHarness /
 *              领域包兼容 packCompatibility
 */
export * from './conformance.js';
export * from './store-conformance.js';
