/**
 * 进展反馈，见 docs/architecture.md §10.4 与 ADR-0018。占位：仅声明契约。
 *
 * ⚠️ 这是**进展**，不是执行过程的实时输出流。三者通道不同：
 *   实时输出（token delta / 工具入参出参）→ StreamSink，高频无界
 *   进展（到第几步、在做什么、累计成本）→ 本模块，低频有界
 *   最终结果                              → outputData，一次
 * 把 token 流写进 task log 会瞬间打爆服务端，且不是编排引擎该消费的东西。
 */

export interface ProgressReport {
  /** 语义化阶段名，由引擎适配器映射，如 'planning' | 'tool:lookupPolicy' | 'finalizing' */
  phase: string;
  /** 已完成的受管调用数 */
  step: number;
  /** 若可预知（plan-execute 类引擎）才有 */
  totalSteps?: number;
  usage: { tokens: number; costUsd: number };
  sliceIndex: number;
  updatedAt: number;
}

/**
 * 写入策略由 Conductor 服务端约束反推（v3.21.21 源码核实，见 ADR-0018）：
 * - taskExecLogSizeLimit 默认 10 → 单次 addLog 调用超过 10 条会被静默截断
 * - NoopIndexDAO（conductor.indexing.enabled=false）→ 日志被静默丢弃
 * - asyncIndexingEnabled 默认 false → 索引写在请求路径上，写太频拖慢服务端
 */
export interface ProgressOptions {
  /** 节流窗口，默认 15_000；phase 变化时立即写一次（leading edge），两者取或 */
  intervalMs?: number;
  /** 单次 addLog 调用的条数上限，默认 10（不可调大 —— 服务端会静默截断） */
  maxLogsPerCall?: number;
  /** 单个 run 的 task log 总量上限，默认 200；超限后只写阶段变化 */
  maxLogsPerRun?: number;
  /** 单条日志截断长度，默认 512 */
  maxLogChars?: number;
}

export interface ProgressReporter {
  /** 由受管入口与分片边界调用；内部节流合并，异步 fire-and-forget，失败不影响主流程 */
  report(r: ProgressReport): void;
  /** 分片交还时取当前快照，写进 outputData.progress（权威通道，零额外请求） */
  snapshot(): ProgressReport | undefined;
}
