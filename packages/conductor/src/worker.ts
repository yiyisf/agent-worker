/**
 * 用户入口：把 AgentDefinition 挂到 Conductor 上。见 docs/architecture.md §6.1。占位。
 *
 * 本层是**薄桥接**（ADR-0006）：poll 循环、并发、心跳、指标、优雅停机全部交给官方
 * `@io-orkes/conductor-javascript` 的 TaskManager；这里只负责把 AgentDefinition 编译成
 * 官方的 ConductorWorker，并在 execute 内外接上 journal / fencing / 结果映射 / 取消检测。
 *
 * 预期用法（M1）：
 *
 *   const worker = createAgentWorker({
 *     agents: [researchAgent],
 *     stateStore: redisStateStore({ url: process.env.REDIS_URL! }),
 *   });
 *   await worker.start();
 */
import type { AgentDefinition, BlobStore, EventSink, StateStore } from '@ca/core';
import type { ConnectionOptions } from './types.js';
import type { CancellationWatcherOptions } from './cancellation.js';

export interface AgentWorkerOptions {
  agents: AgentDefinition[];
  /** 省略则完全走官方 SDK 的 env 约定 */
  connection?: ConnectionOptions;
  workerId?: string;
  /** callback / hybrid 策略、resumePolicy≠never、HITL 任一启用时必须为持久化实现，否则启动即拒绝 */
  stateStore?: StateStore;
  blobStore?: BlobStore;
  eventSinks?: EventSink[];
  maxConcurrentRuns?: number;
  cancellation?: CancellationWatcherOptions;
  /** 启动时注册/校验 TaskDef，默认 'verify' */
  taskDefs?: 'register' | 'verify' | 'skip';
}

export interface AgentWorker {
  start(): Promise<void>;
  shutdown(opts?: { graceMs?: number }): Promise<void>;
}

export declare function createAgentWorker(options: AgentWorkerOptions): AgentWorker;

/**
 * 低阶入口：只编译出官方 SDK 的 ConductorWorker，由调用方自行交给已有的
 * TaskManager / TaskHandler。供已有 worker 工程渐进接入。
 *
 * 返回值形状为官方 `ConductorWorker`：
 *   { taskDefName, execute, leaseExtendEnabled, concurrency, pollInterval, domain }
 */
export declare function compileAgentWorker(
  def: AgentDefinition,
  deps: Omit<AgentWorkerOptions, 'agents'>,
): unknown;
