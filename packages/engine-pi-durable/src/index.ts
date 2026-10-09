/**
 * @ca/engine-pi-durable —— 实验引擎：在 worker 进程内嵌入 Pi Durable harness 库。
 * 见 docs/architecture.md §4.4、§13 实验 S1 与 ADR-0026。
 *
 * 上游：@earendil-works/pi-durable ^1.1.0（模型层 @earendil-works/pi-ai，文档状态 @earendil-works/chord）。
 * 与 @ca/engine-harness 的 Pi 适配互不替代：后者经 AI SDK HarnessAgent 接 Pi coding agent 进程，
 * 模型调用归它所有，只能 per-turn；本包直接嵌入 harness 库，扩展点多得多。
 *
 * 一、状态归 Pi Durable 所有（state: 'engine-session'）
 *
 *   Pi Durable 每步写检查点（spec §5.2「先写意图 → 执行 → 写结果」），已完成的模型响应不重请求，
 *   进行中的请求用相同的消息、模型、推理等级、流式参数重发。避免重复付费由它负责；
 *   本项目的 journal 只记录指向 Pi 存储的引用与 fenceToken。
 *
 * 二、单写者（stateOwnership: 'single-writer'）
 *
 *   Pi Durable 一个存储同一时刻只能有一个进程持有，无跨进程锁。单写者由 Conductor 配置保证：
 *   每个 run 一份存储（键 = runKey）、lease-extend + 分片内保活、retryDelaySeconds ≥ responseTimeoutSeconds，
 *   由 @ca/conductor 的 deriveTaskDef 按本能力推导并校验。
 *   兜底：fencingStorage() 包住 Pi 的 Storage.commit()，提交前校验 fenceToken，落后者抛错中止。
 *
 * 三、受管入口的接法（待实验验证，结论写回 architecture.md §4.4）
 *
 *   模型 → 包装注入 harness 的 models（beforeRequest 抛错只「report, continue」，不能用来拦截预算）
 *   工具 → wrapTool() 装饰 execute；beforeTool 可阻断（护栏）
 *   进展 → conversation view / watch() 映射到 ProgressReport
 *
 * 四、工具策略映射
 *
 *   pure / idempotent → replay: "safe"（idempotent 由 wrapTool 注入 idempotencyKey = tool call id）
 *   effectful         → replay: "unsafe"；Pi 缺省把「被中断」交给模型判断，与 ADR-0005 冲突 →
 *                       适配层拦截该结果，按 onAmbiguousReplay 处理（缺省 fail），不交给模型
 *
 * 实验骨架：只有契约声明，实现随实验 S1 推进。
 */
import type { EngineCapabilities, ToolPolicy } from '@ca/core';

export const PI_DURABLE_ENGINE_ID = 'pi-durable' as const;

/** 能力假设，逐条见 ADR-0026 第 3 节；实验结论出来后改为实测值 */
export const piDurableCapabilities: EngineCapabilities = {
  costVisibility: 'per-call',
  toolInterception: 'all',
  state: 'engine-session',
  suspend: 'none',
  sliceControl: 'none',
  granularity: 'step',
  progress: 'step',
  streaming: true,
  structuredOutput: false,
  stateOwnership: 'single-writer',
};

/** Pi 工具的重放策略（spec §7.3：缺省 'unsafe'） */
export type PiReplay = 'safe' | 'unsafe';

/** ToolPolicy.effect → Pi replay。未声明策略的工具按 core 的约定视为 pure（§4.6） */
export function toPiReplay(policy: ToolPolicy | undefined): PiReplay {
  return policy?.effect === 'effectful' ? 'unsafe' : 'safe';
}

/** spec.engineOptions 中本引擎认的字段（对 core 不透明，由本包校验） */
export interface PiDurableEngineOptions {
  /** pi-ai 的模型引用，如 'anthropic/claude-sonnet-5' */
  model: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  /** 启用的 Pi 扩展名（如 coding agent 的内建工具集） */
  extensions?: string[];
  instructions?: string;
  /** 实验期可用 sqlite（单 worker）；多 worker 接管必须用 postgres（ADR-0026） */
  storage: { kind: 'sqlite'; dir: string } | { kind: 'postgres'; url: string };
}

/**
 * 兜底：包住 Pi Durable 的 Storage，使每次 commit() 前校验 fenceToken（ADR-0026 残余风险）。
 * 只依赖 Storage.commit 的形状，不改 Pi 本身。实现随实验 S1。
 */
export declare function fencingStorage<S extends { commit(...args: never[]): Promise<unknown> }>(
  storage: S,
  assertFence: () => Promise<void>,
): S;
