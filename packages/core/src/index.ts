/**
 * @ca/core —— 与 Conductor 无关的 Agent 运行时。
 *
 * 本包故意不依赖 @ca/conductor：Agent 可以脱离编排引擎单独运行（本地 CLI、单测、HTTP 服务），
 * Conductor 只是驱动它的宿主之一。设计见 docs/architecture.md §3.1。
 *
 * 当前为 M0 骨架：只有契约声明，实现随 M1/M2 落地。
 */
export type * from './agent.js';
export type * from './context.js';
export type * from './tool.js';
export type * from './model.js';
export type * from './journal.js';
export type * from './guardrail.js';
export type * from './events.js';
export type * from './step-executor.js';
