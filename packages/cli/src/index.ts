/**
 * @ca/cli —— 命令行工具。见 docs/architecture.md §6.6 与 §13。
 *
 * M0 骨架：待实现
 *   ca init                  脚手架
 *   ca register [--apply]    由 AgentSpec 推导 TaskDef 并 diff-and-apply
 *   ca spec diff <a> <b>     比较两个 spec 的 effective 配置
 *   ca spec explain <field>  说明某字段来自 L0/L1/L2 哪一层
 *   ca packs list            列出已装领域包及其贡献的扩展位
 *   ca run <agent> --input   本地跑一次 Agent（不连 Conductor）
 *   ca journal <runKey>      查看 / 回放 journal
 *   ca doctor                校验配置（yield 策略是否配了持久化 StateStore 等）
 */
export {};
