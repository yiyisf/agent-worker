/**
 * @ca/core —— 薄契约层 + 可靠性内核。
 *
 * 只做四件事（docs/architecture.md §4）：
 *   1. AgentSpec 契约（纯 JSON，支撑配置化与领域定制）
 *   2. AgentEngine 契约（适配外部 Agent SDK，不自建循环）
 *   3. 两个受管入口（模型 / 工具）—— 可靠性的全部作用点
 *   4. 可靠性内核：Journal / 幂等 / 预算 / Fencing / 能力校验
 *
 * 本包**不依赖任何 Agent SDK，也不依赖 Conductor**。
 * 循环、上下文管理、provider 生态、MCP、结构化输出一律由引擎提供（ADR-0011）。
 *
 * 当前为 M0 骨架：只有契约声明。
 */
export type * from './spec.js';
export type * from './engine.js';
export type * from './journal.js';
export type * from './context.js';
export type * from './guardrail.js';
export type * from './events.js';
export type * from './loader.js';
export * from './gateway.js';
