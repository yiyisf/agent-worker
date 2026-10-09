/**
 * 由 AgentSpec 推导 Conductor TaskDef，见 docs/architecture.md §6.6。
 * 合并了 Claude Projects 版 ca-worker 的 buildTaskDef（nameCn、信封键、重试默认值、保活校验）。
 *
 * 公式：
 *
 *   timeoutSeconds         = ceil(wallClockMs/1000 × 1.2)    // 必须覆盖「所有分片执行 + 所有等待」的总和
 *
 *   # callback（默认）
 *   responseTimeoutSeconds = max(30, ceil(sliceMs/1000 × 3)) // 单片无响应的容忍窗口
 *                                                             // 服务端另加 callbackAfterSeconds，无需为等待留余量
 *   # lease-extend / hybrid（要求服务端 ≥ 3.10.7）
 *   responseTimeoutSeconds = 60                               // 故意设短 = 崩溃检测灵敏度
 *
 * ⚠️ responseTimeoutSeconds 的 30s 下限（源码核实，§2.2）：该值同时决定 Conductor 重新扫描这个工作流的频率 ——
 * WorkflowSweeper.unack() 在工作流有 IN_PROGRESS 任务时，把 decider 队列的 unack 设为 responseTimeoutSeconds + 1 秒。
 * 调小以求「更快发现崩溃」会成比例加重 decider 负载。显式覆盖低于下限时夹到 30s 并告警。
 *
 * 其余硬约束：
 *   1. responseTimeoutSeconds 须满足保活约束（≥ 13s，ADR-0024；30s 下限已满足）且 < timeoutSeconds
 *   2. retryCount 不可为 0 —— responseTimeout 超时会判 TIMED_OUT 并消耗一次重试配额
 *   3. timeoutPolicy 仅作用于 timeoutSeconds，对 responseTimeout 无效（该路径直接 timeoutTask()）
 *   4. 目标部署必填 nameCn（§2.3 #5，ADR-0023）
 */
import type { AgentSpec } from '@ca/core';
import { ENVELOPE_INPUT_KEYS, ENVELOPE_OUTPUT_KEYS } from './envelope/schemas.js';
import { planKeepalive } from './keepalive.js';
import { assertNameCn, type TaskDefInput } from './metadata/types.js';

/** 推导结果；requireNameCn: false 时 nameCn 可缺省 */
export type DerivedTaskDef = TaskDefInput;

export interface DeriveTaskDefOptions {
  /** 默认 true（目标部署要求），见 ADR-0023 */
  requireNameCn?: boolean;
  /** 缺省时使用 spec.conductor.ownerEmail */
  ownerEmail?: string;
  onWarning?: (message: string) => void;
}

export const DEFAULT_SLICE_MS = 60_000;
export const MIN_RESPONSE_TIMEOUT_SECONDS = 30;
export const LEASE_EXTEND_RESPONSE_TIMEOUT_SECONDS = 60;
export const TIMEOUT_FACTOR = 1.2;
export const DEFAULT_RETRY = { count: 2, logic: 'EXPONENTIAL_BACKOFF', delaySeconds: 5 } as const;

const TASK_TYPE_PATTERN = /^[A-Za-z0-9_]+$/;

export function deriveTaskDef(spec: AgentSpec, opts: DeriveTaskDefOptions = {}): DerivedTaskDef {
  const c = spec.conductor ?? {};
  const taskType = c.taskType;
  if (!taskType || !TASK_TYPE_PATTERN.test(taskType)) {
    throw new Error(`${spec.name}: conductor.taskType 只能包含字母、数字、下划线：${String(taskType)}`);
  }
  if (opts.requireNameCn !== false) assertNameCn('TaskDef', { name: taskType, nameCn: c.nameCn });

  const ownerEmail = opts.ownerEmail ?? c.ownerEmail;
  if (!ownerEmail) throw new Error(`${taskType}: 缺少 ownerEmail（conductor.ownerEmail 或推导参数）`);

  const wallClockMs = spec.limits?.wallClockMs;
  if (!wallClockMs || !(wallClockMs > 0)) {
    throw new Error(`${taskType}: limits.wallClockMs 必填，用于推导 timeoutSeconds（须覆盖所有分片执行与等待）`);
  }
  const timeoutSeconds = Math.ceil((wallClockMs / 1000) * TIMEOUT_FACTOR);

  const strategy = c.leaseStrategy ?? 'callback';
  const derivedRt =
    strategy === 'callback'
      ? Math.max(MIN_RESPONSE_TIMEOUT_SECONDS, Math.ceil(((spec.limits?.sliceMs ?? DEFAULT_SLICE_MS) / 1000) * 3))
      : LEASE_EXTEND_RESPONSE_TIMEOUT_SECONDS;
  let responseTimeoutSeconds = c.responseTimeoutSeconds ?? derivedRt;
  if (responseTimeoutSeconds < MIN_RESPONSE_TIMEOUT_SECONDS) {
    opts.onWarning?.(
      `${taskType}: responseTimeoutSeconds=${responseTimeoutSeconds} 低于下限，已夹到 ${MIN_RESPONSE_TIMEOUT_SECONDS}s（该值同时决定 decider 重扫频率，见 §2.2）`,
    );
    responseTimeoutSeconds = MIN_RESPONSE_TIMEOUT_SECONDS;
  }
  planKeepalive(responseTimeoutSeconds); // 不满足保活约束时直接抛错
  if (responseTimeoutSeconds >= timeoutSeconds) {
    throw new Error(
      `${taskType}: timeoutSeconds(${timeoutSeconds}) 必须大于 responseTimeoutSeconds(${responseTimeoutSeconds})，请调大 limits.wallClockMs`,
    );
  }

  const retryCount = c.retry?.count ?? DEFAULT_RETRY.count;
  if (!Number.isInteger(retryCount) || retryCount < 1) {
    throw new Error(`${taskType}: retryCount 不可为 0 —— responseTimeout 超时会消耗一次重试（§2.2）`);
  }

  return {
    name: taskType,
    ...(c.nameCn?.trim() ? { nameCn: c.nameCn.trim() } : {}),
    ...(c.description ? { description: c.description } : {}),
    ownerEmail,
    retryCount,
    retryLogic: c.retry?.logic ?? DEFAULT_RETRY.logic,
    retryDelaySeconds: c.retry?.delaySeconds ?? DEFAULT_RETRY.delaySeconds,
    timeoutSeconds,
    responseTimeoutSeconds,
    timeoutPolicy: 'RETRY',
    inputKeys: [...ENVELOPE_INPUT_KEYS],
    outputKeys: [...ENVELOPE_OUTPUT_KEYS],
    ...(c.rateLimit
      ? { rateLimitPerFrequency: c.rateLimit.perFrequency, rateLimitFrequencyInSeconds: c.rateLimit.frequencyInSeconds }
      : {}),
    ...(c.concurrentExecLimit ? { concurrentExecLimit: c.concurrentExecLimit } : {}),
  };
}

export interface TaskDefDrift {
  name: string;
  field: string;
  local: unknown;
  remote: unknown;
}

/** 启动时校验线上 TaskDef 与本地推导是否漂移；默认告警不阻塞。只比较本地推导出的字段 */
export function diffTaskDefs(local: DerivedTaskDef[], remote: Array<Record<string, unknown>>): TaskDefDrift[] {
  const byName = new Map(remote.map((r) => [r.name, r]));
  const drifts: TaskDefDrift[] = [];
  for (const l of local) {
    const r = byName.get(l.name);
    if (!r) {
      drifts.push({ name: l.name, field: '*', local: l, remote: undefined });
      continue;
    }
    for (const [field, value] of Object.entries(l)) {
      if (JSON.stringify(value) !== JSON.stringify(r[field])) {
        drifts.push({ name: l.name, field, local: value, remote: r[field] });
      }
    }
  }
  return drifts;
}
