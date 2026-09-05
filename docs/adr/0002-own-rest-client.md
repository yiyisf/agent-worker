# ADR-0002：自持精简 REST 客户端，而非依赖官方 JS SDK

- 状态：Accepted
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
