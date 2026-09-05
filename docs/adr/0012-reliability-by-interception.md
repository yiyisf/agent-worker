# ADR-0012：可靠性通过拦截两个入口实现，而非拥有循环

- 状态：Accepted（`suspend` 被 [ADR-0014](0014-native-approval-only-suspension.md) 修订；
  `interceptModel` / `interceptTools` 被 v0.6 换成分级，见下方补充）
- 日期：2026-09-05

## 背景

ADR-0003 的 Journaled Replay 在 v0.3 中依赖「core 拥有循环」：core 驱动每一步，因此能在每步写 journal。
ADR-0011 把循环交给了外部引擎，这个前提消失了。

## 决策

可靠性只依赖**两个受管入口**，与谁拥有循环无关：

```ts
interface ManagedModelGateway {
  guard<T>(call: JsonValue, invoke: () => Promise<{ result: T; usage: Usage }>): Promise<T>;
}
interface ManagedToolGateway {
  guard<T>(toolName: string, input: JsonValue, invoke: () => Promise<T>): Promise<T>;
}
```

`guard` 内部依次执行：journal 命中检查 → 护栏 → 预算 → 幂等键注入 → 执行 → 写 journal → span/指标。

**恢复 = 重跑引擎循环，但每个受管入口都被 journal 短路**：循环照走，不产生真实的模型调用或工具副作用。

引擎适配器的唯一硬性义务是「所有模型调用与工具执行都经过这两个函数」。以 AI SDK 为例，
`wrapLanguageModel` 的 `wrapGenerate` 与包装 `tool.execute` 即可，适配层不到几十行。

## 理由

- 模型调用决定**成本**，工具执行决定**副作用**——可靠性关心的就这两样，
  循环的其余部分（拼消息、判停止条件）既不花钱也无副作用，没有拦截价值。
- 拦截式设计让"支持任意 SDK"成为可能：契约面小到任何引擎都能满足。
- **两个入口天然就是埋点位置**，换引擎不丢 OTel span 与成本指标。

## `EngineCapabilities`：诚实的能力边界

不是所有引擎都能被完整拦截，core 必须显式建模而非假装统一：

```ts
interface EngineCapabilities {
  state: 'messages' | 'snapshot' | 'engine-session' | 'replay';
  suspend: 'native-approval' | 'none';   // ADR-0014 删除了 replay-signal
  interceptModel: boolean;
  interceptTools: boolean;
  granularity: 'step' | 'turn';
  streaming: boolean;
  structuredOutput: boolean;
}
```

启动时做能力—配置一致性校验：

- `interceptTools: false`（如 Claude Code / Codex 这类在 sandbox 内执行工具的 harness）
  → **拒绝**声明了 `effectful` 工具策略的 spec，因为幂等保护实际上不存在。
- `interceptModel: false` → 拒绝启动：journal 形同虚设，用户会误以为有成本保护。
- `granularity: 'turn'` → journal 与恢复退化到 turn 级，恢复改用引擎自己的 session resume state。

**宣称"支持任意 SDK"却不说清能力差异，比不支持更危险**——用户会在 sandbox 型 harness 上
误以为拿到了 effectively-once。`@ca/testing` 的引擎一致性套件专门验证
"声明的 capabilities 与实际行为一致"。

## 代价

- **要求引擎循环可重放**：给定相同输入与相同的 guard 返回值，调用序列必须一致。
  引擎若在循环内读时钟、掷随机数或读外部状态就会漂移。
  → 由引擎一致性套件暴露；`ToolLoopAgent` 这类纯粹的循环天然成立。
- **重放会重跑循环的非受管部分**（拼消息、跑停止条件），有 CPU 开销但无外部代价。
  → 相对被短路掉的 LLM 调用可忽略。

---

## 修订（2026-09-05，ADR-0014）

本 ADR 原先允许 `suspend: 'replay-signal'` —— 在受管工具入口抛异常炸开引擎调用栈来强行挂起。
该路径已删除：机制本身不可控（异常怎么被接由别人决定），而实测 9 个 harness 适配器中
8 个都有原生审批，为 1/9 的场景保留最脆的机制不划算。详见
[ADR-0014](0014-native-approval-only-suspension.md)。

本 ADR 的其余内容（两个受管入口、拦截式可靠性、`EngineCapabilities` 显式建模）不变。

---

## 补充（2026-09-05，v0.6）

本 ADR 原先把可拦截性建模为两个布尔量。按 `ai@7.0.93` 核实后，二者都不够表达真实情况，已改为分级：

- `interceptModel: boolean` → **`costVisibility: 'per-call' | 'per-turn' | 'none'`**。
  原因：AI SDK 的 `HarnessAgent` 接受的 `model` 是 harness 专属**字符串标识符**，
  「harness abstraction is separate from the provider/model abstraction」——
  根本没有可供 `wrapLanguageModel` 包装的模型对象。所以 9 个 harness 适配器**全部**拦不到模型调用，
  连 host-process 的 Cline、Pi 也不例外，与沙箱无关。
  但适配器会归一化 `result.usage`，因此 turn 级记账可行 → 保留为 `'per-turn'`（轮间预算闸门），
  而不是按原规则一律拒绝启动——否则整个 harness 生态直接出局。

- `interceptTools: boolean` → **`toolInterception: 'all' | 'host-declared-only' | 'none'`**。
  原因：harness 的工具有两个来源 —— 内建工具由 harness 运行时执行（拦不到），
  我们用 `tool()` 传进去的 host-declared 工具「executes in your host」（拦得到）。
  一个布尔量表达不了「一半能管一半不能管」。

本 ADR 的核心主张（可靠性只依赖受管入口、不依赖拥有循环；能力必须显式建模而非假装统一）不变，
反而因为这次修正更站得住：**能力模型不够细，就会把"部分可管"误报成"完全不可管"或"完全可管"。**
