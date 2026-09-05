/**
 * @ca/engine-custom —— 最小手写循环参考实现。见 docs/architecture.md §3.3。
 *
 * 三个用途：
 *   1. AgentEngine 契约的参考实现（几十行，证明适配成本足够低）
 *   2. 不想引入任何 Agent SDK 的用户的起点
 *   3. @ca/testing 引擎一致性套件的基线样本 —— 包括一个**故意谎报 capabilities 的假引擎**，
 *      用于验证一致性套件确实能抓到它
 *
 * capabilities: runtimeLocation 'host-process' / state 'snapshot' / suspend 'none' /
 *               sliceControl 'native' / intercept* true / granularity 'step'
 *
 * M0 骨架：待实现
 */
export {};
