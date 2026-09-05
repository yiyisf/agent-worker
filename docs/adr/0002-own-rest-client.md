# ADR-0002：自持精简 REST 客户端，而非依赖官方 JS SDK

- 状态：**Superseded by [ADR-0006](0006-build-on-official-sdk.md)**（2026-09-05）
- 日期：2026-09-05

## 决策

`@ca/conductor` 内置 `HttpConductorClient`，只实现 6 个端点（batch poll、update task、task log、
get workflow、register taskdef、start workflow）；同时暴露 `ConductorClient` 接口，
允许注入基于官方 SDK 的实现。

## 理由

- Conductor OSS 与 Orkes 托管版在鉴权（无认证 / Basic / API Key 换 JWT）与路径前缀上有差异，
  官方 JS SDK 的封装对两端支持并不均衡。
- 我们需要对 poll 的并发、准入控制、退避策略做深度控制（§6.2），SDK 的 `TaskManager` 是黑盒。
- 依赖面小：6 个端点的 HTTP 客户端可控、可测（`FakeConductorServer` 直接实现同一接口）。

## 代价

- Conductor 侧 API 变更需要我们自己跟进。→ 端点少，且都是长期稳定的核心 API；契约测试覆盖。

---

## 推翻原因（2026-09-05）

本 ADR 的前提是「官方 JS SDK 对 OSS 与 Orkes 支持不均衡、`TaskManager` 是黑盒」。
实际核查 `conductor-oss/javascript-sdk` 后，两条前提都不成立：

- 鉴权已统一收敛到 `CONDUCTOR_SERVER_URL` / `CONDUCTOR_AUTH_KEY` / `CONDUCTOR_AUTH_SECRET`，
  且 `createConductorClient/` 已处理重试、HTTP/2、TLS、proxy；集成测试矩阵覆盖 OSS 与 Orkes v4/v5。
- `TaskManager` / `TaskRunner` / `LeaseTracker` / `TaskContext` 都是公开导出的，`concurrency`、
  `pollInterval`、`domain`、`leaseExtendEnabled` 均可配置，并非黑盒。

更关键的是，自持客户端会让我们**错过 `extendLease` 心跳**——这正是 ADR-0004 设计错误的根源。
详见 [ADR-0006](0006-build-on-official-sdk.md)。
