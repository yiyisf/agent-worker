# ADR-0023：定制必填字段 `nameCn`，元数据注册走自有 REST

- 状态：Accepted（Amends [ADR-0006](0006-build-on-official-sdk.md) 中「用官方 `MetadataClient` 注册 TaskDef」一项）
- 日期：2026-10-09

## 背景

目标部署是在 Conductor OSS 3.21.21 上的**定制版本**，TaskDef 与 WorkflowDef 都必须带 `nameCn`（中文名），
缺失则注册失败（ADR-0019 实测 #5）。官方 SDK `@io-orkes/conductor-javascript@4.0.0` 的类型不含该字段，
它在序列化时是否原样保留未知字段**尚未验证**。

v0.6 的 `DerivedTaskDef` 没有该字段，按 ADR-0006 用官方 `MetadataClient` 注册 —— 在目标部署上必然失败。

## 决策

- `@ca/conductor` 定义自有的 `CasTaskDef` / `CasWorkflowDef`（`nameCn` 必填，允许额外字段透传）。
- `AgentSpec.conductor.nameCn` 由 spec 声明；`deriveTaskDef` 与 `MetadataApi` 在提交前校验非空。
- 元数据注册走 `@ca/conductor` 内的窄 REST 实现（`MetadataApi`：`registerTaskDefs` / `upsertWorkflowDefs` / `getTaskDef`），
  确保定制字段原样提交。poll / update / 心跳 / TaskContext 仍全部用官方 SDK，ADR-0006 的其余部分不变。
- 校验可关闭：`requireNameCn: false` 用于对接未定制的 OSS 部署。默认开启，因为目标部署要求它。
- 若验证确认 SDK 4.0.0 保留 `nameCn`，再考虑委托 SDK（跟踪 issue）。

## 后果

- 引擎继续增加定制字段时，只需扩展 `CasTaskDef` 类型与校验。
- 契约测试覆盖 `nameCn` 必填行为；服务端去掉该要求时契约测试会提示。
- 官方 SDK 依赖版本锁定为 `4.0.0`（peerDependency 由 `>=3.0.0` 收紧），避免类型与行为漂移。
