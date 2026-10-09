# 贡献指南

## 分支

- `main` 是唯一长期分支，受保护：必须经 PR、CI 通过、CODEOWNERS 批准，只允许 squash merge。
- 功能分支命名 `feat/<scope>-<topic>`、`fix/…`、`chore/…`，建议 3 天内合并。

## 提交与 PR 标题

squash merge 以 PR 标题作为提交信息，标题需符合 Conventional Commits，例如 `feat(conductor): 分片内保活`。

可用 scope：`core`、`conductor`、`engine-ai-sdk`、`engine-harness`、`engine-custom`、`memory`、`observability`、
`testing`、`cli`、`contract-verify`、`examples`、`docs`、`ci`、`repo`、`deps`。

## 本地检查

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm docs:check-mermaid   # 修改 docs/ 中的 mermaid 图时
```

## 变更记录

修改对外发布的包时执行 `pnpm changeset`。以下变更必须在 changeset 与 PR 中明确说明：

- 信封 `schemaVersion` 或字段、校验规则（ADR-0020）
- TaskDef / WorkflowDef 推导规则（含 `nameCn`，ADR-0023）
- 保活、最终上报、取消、fencing 行为（ADR-0022、ADR-0024）
- `EngineCapabilities` 或引擎契约版本（ADR-0017）

## 分层依赖

见 [docs/architecture.md §3.2](docs/architecture.md#32-分层)，由 ESLint 强制：

- 只有 `@ca/conductor` 可以引用 `@io-orkes/conductor-javascript`。
- `@ca/core` 不依赖任何其他 `@ca` 包、任何 Agent SDK（`ai`、`@ai-sdk/*`）或 Conductor。
- 引擎适配层（`engine-*`）不得依赖 `@ca/conductor`。

## 服务端行为

依赖 Conductor 服务端行为的默认值（保活参数、体积上限、重试映射），注释里须引用
[§2.3](docs/architecture.md#23-契约实测32121-定制版2026-09-29) 的实测编号或 §2.2 的源码位置。
改动这类行为后，手动触发一次 `contract-nightly`。

## ADR

改变已有决策前，先在 `docs/adr/` 新增一篇 ADR，再改代码。旧篇不改写，只更新状态行。
