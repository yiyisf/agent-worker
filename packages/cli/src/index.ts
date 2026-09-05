/**
 * @ca/cli —— 命令行工具。见 docs/architecture.md §6.6 与 §13。
 *
 * M0 骨架：待实现
 *   ca init                  脚手架
 *   ca register [--apply]    由 AgentDefinition 推导 TaskDef 并 diff-and-apply
 *   ca run <agent> --input   本地跑一次 Agent（不连 Conductor）
 *   ca journal <runKey>      查看 / 回放 journal
 *   ca doctor                校验配置（yield 策略是否配了持久化 StateStore 等）
 */
export {};
