/**
 * 示例：L1 领域包 + L2 实例 spec。目标里程碑 M4。见 docs/architecture.md §7、ADR-0013。
 *
 * 演示：
 * - definePack() 打包领域工具（AI SDK tool() 原生格式）、工具可靠性策略、护栏、prompt、
 *   spec 片段与 eval 数据集，版本化分发
 * - L2 实例 spec 用 extends 引用领域包，逐字段覆盖
 * - SpecLoader 三层合并 → effective spec 快照写入 journal 与 outputData，使配置可追溯
 * - ca spec diff / ca spec explain <field> 排查「这个值到底从哪来的」
 *
 * M0 骨架：待实现
 */
export {};
