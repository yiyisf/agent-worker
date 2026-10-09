# ADR-0021：人工介入分两级 —— 任务级 `outcome`，工具级原生审批

- 状态：Accepted（Amends [ADR-0014](0014-native-approval-only-suspension.md)）
- 日期：2026-10-09

## 背景

两版设计对 HITL 给出了不同答案：

- **Projects 版**：agent 返回 `outcome: needs_approval`，任务 `COMPLETED`，由 workflow `SWITCH` 到
  `HUMAN` 任务；审批完成后再启动下一个 agent task。审批发生在**任务之间**，完全由 Conductor 表达。
- **本仓库 v0.6**：引擎原生两段式审批，任务内挂起（`IN_PROGRESS + callbackAfterSeconds`），
  审批写回后同一个 run 接着跑。审批发生在**循环之内**。

两者不是替代关系，粒度不同。

## 决策

**两级并存，优先任务级。**

| | 任务级（`outcome`） | 工具级（`native-approval`） |
|---|---|---|
| 审批对象 | agent 的整体结论或计划 | 循环中的某一次工具调用 |
| 机制 | `COMPLETED` + `outcome` → `SWITCH` → `HUMAN` → 下一个 task | `suspended` → `IN_PROGRESS` 交还 → 写回决定 → 同一 run 续跑 |
| 运行状态 | 结束；下一 task 是新的 run，靠 `handoffs` 交接 | 保留在 `StateStore` |
| 引擎要求 | 无（任何引擎都能返回 `outcome`） | `capabilities.suspend === 'native-approval'` |
| 在 Conductor 中可见 | ✅ 完全可见 | 只见一个 IN_PROGRESS 的任务 |

选择规则：

1. 能把审批点放在任务边界的，用任务级 —— 编排可见、无需持久化中间状态、对引擎零要求。
2. 只有「必须在执行某个 effectful 工具前停下」且停下后要接着用同一上下文的，才用工具级。
3. `suspend: 'none'` 的引擎（Codex）仍可用任务级；ADR-0014 的「声明 `approval` 即拒绝启动」只针对工具级。

## 后果

- `ToolPolicy.approval` 只表示工具级审批；任务级审批不在 spec 里声明，而是 agent 产出与 workflow 设计的约定。
- `examples/hitl-approval` 需要同时演示两级。
- 任务级的代价：两次 run 之间上下文只能靠 `handoffs`（summary + artifacts + result）传递，不能续用对话。
