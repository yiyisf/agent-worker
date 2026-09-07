/**
 * @ca/conductor —— 官方 SDK 之上的薄桥接层（ADR-0006）。
 *
 * 不实现：鉴权、poll 循环、并发、TaskContext、worker 指标 —— 全部来自
 * `@io-orkes/conductor-javascript`（peerDependency）。
 *
 * 只实现：AgentSpec → ConductorWorker 的编译、运行态输入/输出的取用、
 * 结果映射与 payload 外置、取消检测、TaskDef 推导（注册期）。
 */
export * from './types.js';
export * from './taskdef.js';
export * from './task-io.js';
export * from './result-mapper.js';
export * from './cancellation.js';
export * from './worker.js';
export * from './progress.js';
