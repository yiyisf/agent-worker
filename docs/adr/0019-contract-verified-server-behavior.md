# ADR-0019：服务端行为以契约实测为准，`contract-verify` 每晚复核

- 状态：Accepted
- 日期：2026-10-09

## 背景

v0.3–v0.6 的 Conductor 语义结论全部来自 **v3.21.21 服务端源码阅读**（§2.2）。
另一版设计（Claude Projects 中的 `ca-worker`）在目标部署——**3.21.21 定制版**——上
用 `tools/contract-verify` 做了 4 组实测（2026-09-29）。两者大部分吻合，但实测给出了源码阅读没有覆盖的事实：

| # | 实测结论 | 源码阅读是否覆盖 | 影响 |
|---|---|---|---|
| 1 | `IN_PROGRESS` 更新会把队列消息推迟 `callbackAfterSeconds`；取 0 或小于心跳周期时，**同一 taskId** 每次心跳后都能被其他 worker 拉到（90s 内 22–23 次）；取值 = `responseTimeoutSeconds` 时无重复拉取、无超时重试 | 部分（只知道 `requeue` 的下限钳制） | ADR-0024 |
| 2 | 每次重试生成新 taskId，`retriedTaskId` 指向上一次；`FAILED_WITH_TERMINAL_ERROR` 不重试 | 是 | 不变 |
| 3 | 任务因响应超时生成重试后，原 worker 迟到的 `COMPLETED` **仍返回 HTTP 200**，并把原记录从 `TIMED_OUT` 改写为 `COMPLETED`；工作流不采用该结果 | **否** | ADR-0022 |
| 4 | output ≤ 1MB 内联；3MB / 5MB 被服务端外部化；10MB 被置为 `FAILED_WITH_TERMINAL_ERROR`，**但上报接口仍返回 HTTP 200** | **否** | ADR-0022 |
| 5 | 定制版 TaskDef / WorkflowDef **必填 `nameCn`** | **否**（定制字段，不在 OSS 源码里） | ADR-0023 |
| 6 | Task Log 可读写；TaskDef 会持久化 `inputSchema` / `outputSchema` 字段（是否据此校验未验证） | 部分（§10.4 的索引约束） | 不变 |

## 决策

1. **源码阅读与实测冲突时以实测为准**，并在 §2.3 记录实测结论与日期。
2. `tools/contract-verify` 迁入本仓库，内网 self-hosted runner **每晚**对测试环境运行；
   失败自动建 issue（`risk:contract`）。服务端升级或配置变更后必须先过一轮。
3. **补一组实验**：`extendLease` 心跳。v0.3 以来关于它的结论（只改 `updateTime`、不碰队列）
   仅来自源码阅读，从未实测；ADR-0024 的默认保活方式依赖它。

## 后果

- SDK 内凡是依赖服务端行为的默认值（保活参数、体积上限、重试映射），注释里都要引用实测编号或源码位置。
- 契约测试需要可访问的非生产 Conductor；只在 `schedule` / `workflow_dispatch` 下运行，
  不响应 `pull_request`，避免不受信任的代码在内网 runner 上执行。
