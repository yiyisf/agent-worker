/**
 * @ca/conductor —— 官方 SDK 之上的薄桥接层（ADR-0006）。
 *
 * 不实现：鉴权、poll 循环、并发、心跳续租、TaskContext、worker 指标 —— 全部来自
 * `@io-orkes/conductor-javascript`（peerDependency）。
 *
 * 只实现：AgentSpec → ConductorWorker 的编译、租约策略与 Fencing、进展回写（§10.4）、
 * 结果映射与 payload 外置、取消检测、令牌预算驱动的动态并发、TaskDef 推导。
 *
 * 当前为 M0 骨架：只有契约声明。见 docs/architecture.md §6。
 */
export type * from './types.js';
export type * from './result-mapper.js';
export type * from './cancellation.js';
export type * from './admission.js';
export * from './progress.js';
export * from './lease.js';
export * from './taskdef.js';
export * from './worker.js';
