/**
 * @ca/tools-mcp —— MCP server 到 Tool 的桥接（ToolProvider 实现）。
 * 见 docs/architecture.md §7.2。
 *
 * M0 骨架：待实现
 * - stdio / streamable HTTP transport，连接池绑定 worker 进程生命周期
 * - 工具发现与命名空间化（`<server>.<tool>`）
 * - 会话状态不跨 run 复用：独立会话或显式 reset
 * - MCP 返回值统一标记 trust: 'untrusted'（§11）
 */
export {};
