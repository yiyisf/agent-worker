/**
 * 由 AgentSpec 推导 Conductor TaskDef，见 docs/architecture.md §6.6。
 *
 * ⚠️ 这是一个**只写不读**的注册期工具（ADR-0020）。
 * 它的产物交给 MetadataClient.registerTask，**绝不能**出现在 execute() 的调用栈上 ——
 * TaskDef 里除 name 外的字段全部是给编排引擎做调度控制用的，worker 不读。
 *
 * 取值理由（均据 3.21.21 源码核实，见 §2.2）：
 *
 * timeoutSeconds = 0
 *   `checkTaskTimeout` 首行即 `if (… || taskDef.getTimeoutSeconds() <= 0 || …) return;`。
 *   长时间运行的 agent 不设总时长上限，跑飞由 worker 自己的 limits.wallClockMs 兜底。
 *   需要硬 SLA 上限的部署可用 conductor.taskTimeoutSeconds 显式指定。
 *
 * responseTimeoutSeconds = 3600（服务端默认值）
 *   异步化之后 execute() 毫秒级返回，worker 从不长时间持有任务，这个值几乎用不上。
 *   刻意**不调小**：调小会让 decider 抢在队列 unack 之前把任务判 TIMED_OUT 并消耗一次
 *   retryCount（换新 taskId），而队列 unack 走的是同 taskId 重投，更便宜也更符合语义。
 *
 * retryCount = 3
 *   留给真正的业务失败。孤儿运行的重启不走这条路（ADR-0021），不消耗它。
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

/** Conductor 服务端 TaskDef.responseTimeoutSeconds 的默认值（ONE_HOUR） */
export const SERVER_DEFAULT_RESPONSE_TIMEOUT_SECONDS = 3600;

export function taskTypeOf(spec: AgentSpec): string {
  return spec.conductor?.taskType ?? `agent_${spec.name}`;
}

export function deriveTaskDef(spec: AgentSpec): DerivedTaskDef {
  const override = (spec.conductor as { taskTimeoutSeconds?: number } | undefined)?.taskTimeoutSeconds;
  return {
    name: taskTypeOf(spec),
    retryCount: 3,
    retryLogic: 'EXPONENTIAL_BACKOFF',
    retryDelaySeconds: 5,
    timeoutSeconds: override ?? 0,
    responseTimeoutSeconds: SERVER_DEFAULT_RESPONSE_TIMEOUT_SECONDS,
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
 * 这是**运维视角**的检查，不是 worker 运行期依赖 —— 漂移了也不影响 execute() 的行为。
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
