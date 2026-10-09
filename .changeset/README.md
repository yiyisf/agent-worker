# Changesets

修改任何对外发布的包时，在 PR 中执行 `pnpm changeset` 添加一条变更记录。

信封 `schemaVersion`、TaskDef 推导规则（含 `nameCn`）、保活参数、Fencing 与上报行为的变更必须在描述中明确写出，
并视为 minor（0.x 阶段）或 major。
