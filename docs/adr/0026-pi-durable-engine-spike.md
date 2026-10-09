# ADR-0026：引入 Pi Durable 作为实验引擎，单写者由 Conductor 任务配置保证

- 状态：Accepted（实验阶段；是否转正由实验出口评审决定）
- 日期：2026-10-09

## 背景

[`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable)（MIT，当前 1.1.0）
是 Pi 的持久化 agent harness，已正式并入 Pi coding agent。它与本项目的关系：

| | Pi Durable | 本项目 |
|---|---|---|
| 推理循环 | 自带（`pi.generation` / `pi.tool` 任务，模型层 `pi-ai`） | 不拥有，交给引擎（ADR-0011） |
| 恢复 | 每步检查点；「先写意图 → 执行 → 写结果」（spec §5.2 effect sandwich） | Journal 拦截两个入口（ADR-0012） |
| 工具重放 | `replay: "safe" \| "unsafe"`，缺省 `unsafe`：恢复后告诉模型「被中断」 | `effect: pure \| idempotent \| effectful`，`effectful` 缺省 `fail`（ADR-0005） |
| 模型调用恢复 | 已完成的响应不重请求；进行中的请求用**相同的消息、模型、推理等级、流式参数**重发 | 由 journal 短路 |
| 存储 | 内存 / SQLite / JSONL / Cloudflare DO；`Storage` 接口可自实现 | `StateStore`（redis / postgres） |
| 并发 | **一个存储同一时刻只能有一个进程持有，无跨进程锁** | `fenceToken` |

两者对恢复问题的结论高度一致；Pi Durable 是进程内 TypeScript 库，扩展点比
`@ca/engine-harness`（经 AI SDK `HarnessAgent` 接 Pi coding agent，只能 `per-turn`）丰富得多。
值得用实验确认它作为引擎的适配度。

## 决策

### 1. 新增实验包 `@ca/engine-pi-durable`，与 M1 并行

作为第四个引擎适配器，`state: 'engine-session'`：**避免重复付费由 Pi Durable 自己的恢复负责**，
本项目的 journal 只记录指向 Pi 存储的引用与 fence（§4.4 已为这种情况预留）。
与 `@ca/engine-harness` 的 Pi 适配互不替代：后者接的是 Pi coding agent 进程，前者直接嵌入 harness 库。

### 2. 单写者由 Conductor 任务配置保证（主手段）

Pi Durable 没有跨进程锁，因此必须保证**同一个 run 的存储任一时刻只被一个 worker 打开**。
这由编排层配置实现，不在 Pi 存储层另造锁：

| 配置 | 取值 | 保证的事 |
|---|---|---|
| **每个 run 一份存储** | 存储键 = `runKey`（`workflowInstanceId:taskReferenceName:epoch`） | 不同 run、不同任务实例之间天然不共享 |
| **租约策略** | `lease-extend`（不用 `callback`） | 一次 run 在一次 `execute()` 内跑完，正常路径上不交还任务，不会被别的 worker 中途接走 |
| **分片内保活** | ADR-0024，间隔 `0.4 × responseTimeoutSeconds`，连续 2 次失败即 abort | worker 失联时最迟约 `0.8 × responseTimeoutSeconds` 自行停止，早于服务端重投（≥ `responseTimeoutSeconds`） |
| **重试间隔** | `retryDelaySeconds ≥ responseTimeoutSeconds` | 新 taskId 还要再等一个间隔才可被拉到，给旧 worker 的 abort（取消进行中的模型调用与工具、关闭存储）留出完成的余量 |
| **重试次数** | `retryCount ≥ 1` | 崩溃后由新实例打开同一份存储（`resumePolicy: on-lease-loss`，epoch 不变）接着跑 |
| **归属检查** | ADR-0022，终态上报前 `getTask` | 迟到的旧 worker 不改写任务记录 |

`deriveTaskDef` 对 `engine: 'pi-durable'` 的 spec 按上表推导并校验，不满足时拒绝启动。

**残余风险**：进程被整体冻结（长 GC、虚拟机暂停）超过上述窗口后又恢复，可能与新 worker 同时写。
实验中用一个**fencing 装饰器**包住 Pi 的 `Storage.commit()`（提交前校验 `fenceToken`，落后者抛错并中止）
作为兜底，并测量它是否真的需要；装饰器只有几十行，不改 Pi 本身。

### 3. 能力假设（实验逐条验证）

| 能力 | 假设 | 依据（Pi Durable spec） | 验证方法 |
|---|---|---|---|
| `costVisibility` | `per-call` | harness 接受注入的 `models`，可包装模型调用；`afterResponse` 带 usage | 包装 `models`，确认每次请求都经过受管入口，含恢复时的重发 |
| 调用**前**预算拦截 | 需经包装后的 `models` 实现 | `beforeRequest` 抛错只「report, continue」，**不能**用来拦截 | 超预算时从包装层抛 abort，确认 run 干净地失败 |
| `toolInterception` | `all` | `wrapTool()` 装饰工具执行；`beforeTool` 可阻断 | 包括 Pi coding agent 内建工具在内全部经过 `ManagedToolGateway` |
| `state` | `engine-session` | 存储即会话 | — |
| `sliceControl` | `none` | 规范里没有「在步骤边界停下并交还」的接口 | 确认后固定用 `lease-extend` |
| `suspend` | `none` | 未见原生两段式审批 | 工具级审批不可用；任务级 `outcome` 审批照常可用（ADR-0021） |
| `granularity` / `progress` | `step` / `step` | 每步检查点；`watch()` / conversation view | 进展映射到 `ProgressReport` |

### 4. 工具策略映射

| `ToolPolicy.effect` | Pi `replay` | 恢复时 |
|---|---|---|
| `pure` / `idempotent` | `"safe"` | Pi 用存储的原参数重跑；`idempotent` 由 `wrapTool` 注入 `idempotencyKey`（取 tool call id） |
| `effectful` | `"unsafe"` | Pi 默认把「被中断」交给模型判断。**这与 ADR-0005 冲突**：已有实测显示模型会重试非幂等写操作（重复的 Gmail 草稿）。适配层必须拦截这一结果，按 `onAmbiguousReplay` 处理（缺省 `fail`：让 run 失败），**不交给模型** |

## 实验出口标准（全部满足才转正）

1. 在 3.21.21 定制版上跑通 `minimal-agent` 的 Pi Durable 版本，含**在工具执行中途杀 worker → 新 taskId 接管 → 从检查点续跑**。
2. 双 worker 竞争测试中，按上表配置不出现同一存储被两个进程同时写入；fencing 装饰器的拦截次数有记录。
3. 第 3 节能力假设逐条有结论，结论写回 §4.4 能力表。
4. `effectful` 工具在恢复时不会被模型自行重试（第 4 节）。
5. PG 实现的 `Storage` 通过 Pi Durable 自带的存储一致性测试（若有）及本项目的崩溃注入测试。

## 后果

- 新增一个依赖面（`pi-ai`、`chord`、TypeBox），只出现在 `@ca/engine-pi-durable` 内；`@ca/core` 与其他引擎不受影响。
- 这个引擎**不使用** `callback` 默认策略，是第一个强制 `lease-extend` 的引擎：长时间的人工等待只能走任务级审批。
- 需要实现 PG 版 Pi `Storage`：本地 SQLite / JSONL 文件不能在多个 worker 之间共享。实验期可先用单 worker + 本地 SQLite 验证语义，再换 PG 验证接管。
- 可借鉴项不等实验结论，直接纳入核心设计：
  - **恢复时固定请求参数**（相同消息、模型、推理等级、流式选项）写入 §5.1 对引擎的确定性要求；
  - **带版本的检查点与迁移**：journal 条目带格式版本，读到更新或无法迁移的版本时阻塞而不是静默跑错（M2）；
  - 上表中的 Gmail 重复草稿实测作为 ADR-0005 的佐证。
