/**
 * @ca/tools-mcp —— **本地** MCP server 到 Tool 的桥接（ToolProvider 实现）。
 * 见 docs/architecture.md §7.2。
 *
 * 为什么不用官方的 mcpTool：官方 SDK 的 `mcpTool` 是 serverTool —— 由 Conductor **服务端**
 * 连接 MCP server，不产生本地 worker。这对内网 MCP server、本地文件系统工具、
 * 需要本地凭据的 MCP 够不着。若目标 MCP server 公网可达且可让服务端持有凭据，
 * 应优先用官方 mcpTool，不要用本包。
 *
 * M0 骨架：待实现
 * - stdio / streamable HTTP transport，连接池绑定 worker 进程生命周期
 * - 工具发现与命名空间化（`<server>.<tool>`）
 * - 会话状态不跨 run 复用：独立会话或显式 reset
 * - MCP 返回值统一标记 trust: 'untrusted'（§11）
 */
export {};
