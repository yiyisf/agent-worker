/**
 * 用户入口：把 AgentDefinition 挂到 Conductor 上。见 docs/architecture.md §3.1。占位。
 *
 * 预期用法（M1）：
 *
 *   const worker = createAgentWorker({
 *     conductor: { baseUrl: process.env.CONDUCTOR_URL! },
 *     agents: [researchAgent],
 *     stateStore: redisStateStore({ url: process.env.REDIS_URL! }),
 *   });
 *   await worker.start();
 */
import type { AgentDefinition, BlobStore, EventSink, StateStore } from '@ca/core';
import type { ConductorClient, ConductorClientOptions } from './client.js';
import type { CancellationWatcherOptions } from './cancellation.js';

export interface AgentWorkerOptions {
  conductor: ConductorClientOptions | { client: ConductorClient };
  agents: AgentDefinition[];
  workerId?: string;
  /** yield 策略 / resumePolicy≠never / HITL 任一启用时必须为持久化实现，否则启动即拒绝 */
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
