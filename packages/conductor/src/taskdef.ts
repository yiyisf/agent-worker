/**
 * 由 AgentSpec 推导 Conductor TaskDef，见 docs/architecture.md §6.6。
 *
 * ⚠️ 这是一个**只写不读**的注册期工具（ADR-0020）。
 * 它的产物交给 MetadataClient.registerTask，**绝不能**出现在 execute() 的调用栈上 ——
 * TaskDef 里除 name 外的字段全部是给编排引擎做调度控制用的，worker 不读。
 *
 * 取值理由（均据 3.21.21 源码核实，见 §2.2）：
 *
 * responseTimeoutSeconds = 60
 *   extendLease 模式下这个值是**崩溃检测灵敏度**，不是运行时长上限：
 *   worker 活着就一直有心跳（官方 LeaseTracker 按它 ×0.8 发），任务想跑多久跑多久；
 *   worker 挂了就没人心跳，decider 在这个时长后判 TIMED_OUT、消耗一次 retryCount、
 *   生成新 taskId 重新分配。60 秒 → 心跳每 48 秒一次，崩溃约 60~90 秒被发现。
 *   ⚠️ 不能设太小（< 1.25 秒官方直接跳过心跳），也不宜太小 ——
 *   该值同时决定 Conductor 重扫这个工作流的频率（WorkflowSweeper.unack = 它 + 1 秒）。
 *
 * timeoutSeconds = 0
 *   `checkTaskTimeout` 首行即 `if (… || taskDef.getTimeoutSeconds() <= 0 || …) return;`。
 *   长时间运行的 agent 不设总时长上限，跑飞由 worker 自己的 limits.wallClockMs 兜底
 *   （超了 execute() 会以终局错误返回，不必等引擎判超时）。
 *   需要硬 SLA 上限的部署可用 conductor.taskTimeoutSeconds 显式指定。
 *
 * retryCount = 3
 *   extendLease 模式下这个配额是**真的会被 worker 崩溃消耗**的，不可为 0。
 */
import { DEFAULT_RESPONSE_TIMEOUT_SECONDS } from '@ca/core';
import type { AgentSpec } from '@ca/core';
import { assertHeartbeatViable } from './lease.js';

/** 结构对齐官方 SDK 的 TaskDef，注册时交给官方 MetadataClient */
export interface DerivedTaskDef {
  name: string;
  retryCount: number;
  retryLogic: 'FIXED' | 'EXPONENTIAL_BACKOFF';
  retryDelaySeconds: number;
  timeoutSeconds: number;
  responseTimeoutSeconds: number;
  timeoutPolicy: 'RETRY' | 'TIME_OUT_WF' | 'ALERT_ONLY';
  concurrentExecLimit?: number;
  rateLimitPerFrequency?: number;
  rateLimitFrequencyInSeconds?: number;
}

export function taskTypeOf(spec: AgentSpec): string {
  return spec.conductor?.taskType ?? `agent_${spec.name}`;
}

export function responseTimeoutOf(spec: AgentSpec): number {
  return spec.conductor?.responseTimeoutSeconds ?? DEFAULT_RESPONSE_TIMEOUT_SECONDS;
}

export function deriveTaskDef(spec: AgentSpec): DerivedTaskDef {
  const responseTimeoutSeconds = responseTimeoutOf(spec);
  assertHeartbeatViable(responseTimeoutSeconds);
  return {
    name: taskTypeOf(spec),
    retryCount: 3,
    retryLogic: 'EXPONENTIAL_BACKOFF',
    retryDelaySeconds: 5,
    timeoutSeconds: spec.conductor?.taskTimeoutSeconds ?? 0,
    responseTimeoutSeconds,
    timeoutPolicy: 'RETRY',
  };
}

export interface TaskDefDrift {
  name: string;
  field: string;
  local: unknown;
  remote: unknown;
}

const COMPARED: (keyof DerivedTaskDef)[] = [
  'retryCount',
  'retryLogic',
  'timeoutSeconds',
  'responseTimeoutSeconds',
  'timeoutPolicy',
];

/**
 * 启动时校验线上 TaskDef 与本地定义是否漂移；默认告警不阻塞。
 *
 * ⚠️ extendLease 模式下 `responseTimeoutSeconds` 的漂移**是要紧的**：
 * 官方 LeaseTracker 读的是**运行态任务上的快照值**（调度那一刻从线上 TaskDef 复制），
 * 线上被调小到 1.25 秒以下会让心跳被静默跳过。所以这条漂移应当当成告警看待。
 */
export function diffTaskDefs(
  local: readonly DerivedTaskDef[],
  remote: readonly Partial<DerivedTaskDef>[],
): TaskDefDrift[] {
  const byName = new Map(remote.map((d) => [d.name, d]));
  const drift: TaskDefDrift[] = [];
  for (const def of local) {
    const found = byName.get(def.name);
    if (!found) {
      drift.push({ name: def.name, field: '*', local: 'defined', remote: 'missing' });
      continue;
    }
    for (const field of COMPARED) {
      if (found[field] !== undefined && found[field] !== def[field]) {
        drift.push({ name: def.name, field, local: def[field], remote: found[field] });
      }
    }
  }
  return drift;
}
