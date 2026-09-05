/**
 * 由 AgentSpec.limits 推导 Conductor TaskDef，见 docs/architecture.md §6.6。
 *
 * 公式：
 *   # callback（默认）
 *   responseTimeoutSeconds = max(30, ceil(sliceMs/1000 × 3))
 *   timeoutSeconds         = ceil(wallClockMs/1000 × 1.2)
 *
 *   # lease-extend / hybrid（要求服务端 ≥ 3.10.7）
 *   responseTimeoutSeconds = 60（且必须 ≥ 1.25）
 *   timeoutSeconds         = ceil(wallClockMs/1000 × 1.2)
 *
 * ⚠️ responseTimeoutSeconds 的 30s 下限（源码核实，architecture.md §2.2）：
 * 该值不只是「多久判定超时」，**它同时决定 Conductor 重新扫描这个工作流的频率** ——
 * WorkflowSweeper.unack() 在工作流有 IN_PROGRESS 任务时，把 decider 队列的 unack 设为
 * responseTimeoutSeconds + 1 秒。所以把它调小以求「更快发现崩溃」会成比例加重 decider 负载：
 * 设成 10s，该工作流就每 11s 被扫一次；1000 个并发工作流即每秒多出约 90 次扫描。
 * 顺带：崩溃检测延迟 ≈ responseTimeoutSeconds + 1s，既非 500ms 也非无界。
 *
 * 另两条硬约束：
 *   1. timeoutSeconds 从 startTime 起算且**不加** callbackAfterSeconds，
 *      因此必须覆盖「所有分片执行 + 所有等待」的总和。HITL 等一天就得按一天配。
 *   2. retryCount **不可为 0** —— responseTimeout 超时会把任务判 TIMED_OUT 并消耗一次重试配额。
 *      另注：timeoutPolicy 对 responseTimeout 无效（该路径直接 timeoutTask()）。
 */
import type { AgentSpec } from '@ca/core';

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

/** responseTimeoutSeconds 的下限，理由见文件头 */
export const MIN_RESPONSE_TIMEOUT_SECONDS = 30;
/** lease-extend 模式下故意设短：它是崩溃检测灵敏度，不是运行时长上限 */
export const LEASE_EXTEND_RESPONSE_TIMEOUT_SECONDS = 60;

export const DEFAULT_WALL_CLOCK_MS = 300_000;
export const DEFAULT_SLICE_MS = 60_000;

export function taskTypeOf(spec: AgentSpec): string {
  return spec.conductor?.taskType ?? `agent_${spec.name}`;
}

export function deriveTaskDef(spec: AgentSpec): DerivedTaskDef {
  const lease = spec.conductor?.leaseStrategy ?? 'callback';
  const wallClockMs = spec.limits?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const sliceMs = spec.limits?.sliceMs ?? DEFAULT_SLICE_MS;

  const responseTimeoutSeconds =
    lease === 'callback'
      ? Math.max(MIN_RESPONSE_TIMEOUT_SECONDS, Math.ceil((sliceMs / 1000) * 3))
      : LEASE_EXTEND_RESPONSE_TIMEOUT_SECONDS;

  return {
    name: taskTypeOf(spec),
    // 不可为 0：租约超时会消耗一次重试配额，没有配额时任务直接失败
    retryCount: 3,
    retryLogic: 'EXPONENTIAL_BACKOFF',
    retryDelaySeconds: 5,
    timeoutSeconds: Math.ceil((wallClockMs / 1000) * 1.2),
    responseTimeoutSeconds,
    // 注意：只对 timeoutSeconds 生效，对 responseTimeout 无效
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

/** 启动时校验线上 TaskDef 与本地定义是否漂移；默认告警不阻塞 */
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
