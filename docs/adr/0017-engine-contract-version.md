# ADR-0017：引擎契约版本，把上游版本耦合收敛到自己控制的一层

- 状态：Accepted
- 日期：2026-09-05

## 背景

领域包（Domain Pack）里的工具用引擎的原生格式写（AI SDK 的 `tool()`），
因此上游 SDK 换代时包可能失效。直接让包声明 `ai@^5` 是错的 ——
那把领域包和一个我们控制不了的版本号绑死了，上游发个 major，所有包一起破。

## 决策

**每个引擎适配器自带一个由我们维护的 `contractVersion`**，领域包声明兼容范围，
`SpecLoader` 在三层合并时校验：

```ts
export const engine: AgentEngine = { id: 'ai-sdk/tool-loop', contractVersion: 1, /* ... */ };

definePack({ name: '@acme/ca-pack-insurance', engines: { 'ai-sdk/tool-loop': '^1' }, /* ... */ });
```

`contractVersion` 只在**适配器暴露给 Pack 的形状**发生破坏性变化时才 +1 ——
例如工具定义格式变了、工具策略字段语义变了。上游 SDK 的版本号与它无关。

## 理由

适配器实际只依赖上游 3 个 API 面：`wrapLanguageModel` 中间件、包装 `tool.execute`、
`stopWhen` 自定义停止条件 —— 都是最底层、最稳定的部分。
上游发布新版本时，只要这三处没动，`contractVersion` 就不变，所有领域包无需跟随升级。

类比 USB：设备只认「USB 3.0」这个接口标准，不必关心主板换了什么型号。
把版本耦合收敛到自己能控制的一层，是让第三方生态能长期存活的前提。

## 与 CI 策略的配合

不建多版本矩阵（组合爆炸、维护成本高、收益低）。做法是：

1. CI 只跑 `latest` 与 `peerDependencies` 声明的下界两个版本。
2. 引擎一致性套件充当 canary —— 上游一旦动了那 3 个面，它先红。
3. 适配器 README 显式列出「我们用到的 API 面」，升级时知道盯什么。
4. 依赖机器人盯上游 minor，一致性套件绿了才合。

## 代价

- 多一层版本号要维护，且需要纪律：**改了 Pack 可见的形状就必须 +1**，
  否则这层保护是假的。由一致性套件中的「Pack 兼容性」用例把关。
- 领域包必须声明 `engines`，不声明则 `SpecLoader` 拒绝加载（不给"忘了写"留余地）。
