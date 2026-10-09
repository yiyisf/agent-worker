# @ca/contract-verify

> 自 Claude Projects 版 `ca-worker` 迁入（ADR-0019）：在仓库根目录执行 `pnpm verify:contract`，内网 CI 由 `.github/workflows/contract-nightly.yml` 每晚运行。
> 当前引擎要求 TaskDef / WorkflowDef 必填 `nameCn`，脚本以 `NAME_CN_PREFIX`（默认“CAS契约验证”）加名称自动生成。

在 Conductor OSS v3.21.21 上实测 Agent Worker SDK 设计所依赖的服务端行为。结果记录在 [architecture.md §2.3](../../docs/architecture.md#23-契约实测32121-定制版2026-09-29)，决定保活参数、上报校验和 `maxOutputBytes` 默认值。

## 验证什么

| 实验 | 问题 | 影响的设计 |
| --- | --- | --- |
| 1. heartbeat | IN_PROGRESS 心跳 + `callbackAfterSeconds` 能否续约？取值过小是否会让同一任务被其他 worker 重复拉取？`extendLease: true` 是否不碰队列且能续约？ | 保活模式与参数（ADR-0024） |
| 2. retry | 重试是否生成新 taskId？`FAILED_WITH_TERMINAL_ERROR` 是否跳过重试？ | 执行 ID、任务键、幂等键划分；错误状态映射 |
| 3. payload | task output 多大会被外部化或拒绝？ | `maxOutputBytes`、外部化策略 |
| 4. probes | Task Log 能否读写？TaskDef 是否保存 inputSchema / outputSchema？ | 日志双写、schema 注册 |

实验 1 同时跑五个变体：不发心跳（基线）、`callbackAfterSeconds=0`、小于心跳周期、等于 `responseTimeoutSeconds`、`extendLease: true`。基线用来确认观察窗口内服务端确实会触发超时，否则其他变体的“安全”结论不可信。

## 运行

需要 Node.js ≥ 20。

```bash
pnpm install
# 推荐：指向与生产配置一致的非生产环境（payload 阈值、超时检测周期都取决于服务端配置）
CONDUCTOR_URL=http://<host>:8080/api pnpm verify:contract     # 在仓库根目录
```

总耗时约 2–3 分钟。报告写入 `report/verify-<时间>.md`（结论）与 `.json`（原始数据）。


### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONDUCTOR_URL` | 无 | 服务端地址，含 `/api` |
| `CONDUCTOR_TOKEN` | 无 | 前置网关鉴权时的 Bearer token |
| `CONDUCTOR_IMAGE` | 无 | 不设 `CONDUCTOR_URL` 时用 testcontainers 拉起该镜像（需自包含存储；仅建议用于 CI） |
| `RESPONSE_TIMEOUT_SECONDS` | 10 | 实验 1 的 TaskDef `responseTimeoutSeconds` |
| `HEARTBEAT_EVERY_SECONDS` | 4 | 心跳周期，须小于上一项 |
| `OBSERVE_SECONDS` | 90 | 模拟长任务的执行时长；报告提示“基线无效”时调大到 180 |
| `PAYLOAD_SIZES_KB` | 64,256,1024,3072,5120,10240 | 实验 3 的档位 |
| `ONLY` | 全部 | 只跑部分实验，如 `ONLY=heartbeat,retry` |
| `OWNER_EMAIL` | cas-verify@example.com | 元数据的 ownerEmail |
| `NAME_CN_PREFIX` | CAS契约验证 | 生成 `nameCn` 的前缀 |
| `CLEANUP` | 1 | 设为 0 则保留创建的 TaskDef / WorkflowDef 便于在 UI 中查看 |

### 官方 SDK 冒烟（可选）

```bash
CONDUCTOR_URL=http://<host>:8080/api pnpm --filter @ca/contract-verify verify:sdk
```

用 `TaskManager` 跑通一次 poll → execute → updateTask。官方 SDK 各版本 API 命名可能不同，锁定版本后若编译失败，按实际 API 调整 `src/sdk-smoke.ts`。

## 对环境的影响

- 创建前缀为 `cas_verify_<随机>` 的 TaskDef 和 WorkflowDef，结束时删除。
- 执行记录保留（状态为 COMPLETED / FAILED / TERMINATED），可在 UI 中按前缀查找。
- 实验 3 会提交最大 10 MB 的 output，请避免直接对生产环境运行。

## 结构

```
src/
  rest.ts          直接调用 REST API（不依赖官方 SDK，避免版本差异干扰结论）
  defs.ts          TaskDef / WorkflowDef 构造、元数据登记与清理
  experiments/     四个实验
  report.ts        生成 Markdown 结论
  verify.ts        入口
  sdk-smoke.ts     官方 SDK 冒烟
  container.ts     testcontainers 模式
```
