/**
 * 问题 1：IN_PROGRESS 心跳 + callbackAfterSeconds 能否续约，且不导致任务被其他 worker 重复拉取？
 *
 * 做法：worker-A 拉到任务后长时间执行（observeSeconds，远大于 responseTimeoutSeconds），
 * 期间按固定周期发 IN_PROGRESS 心跳；worker-B 每秒轮询同一任务类型，记录它拉到了什么。
 * 对比五种变体：不发心跳（基线）、callbackAfterSeconds=0、小于心跳周期、等于 responseTimeoutSeconds，
 * 以及 extendLease: true（ADR-0019 决策 3：此前只有源码阅读结论，决定 ADR-0024 的默认保活模式）。
 */
import type { ConductorRest } from '../rest.js';
import { pollUntil, type Registry } from '../defs.js';
import { log, sleep } from '../util.js';

export interface HeartbeatConfig {
  responseTimeoutSeconds: number;
  heartbeatEverySeconds: number;
  observeSeconds: number;
}

export type HeartbeatMode = 'none' | 'in-progress' | 'extend-lease';

export interface HeartbeatVariant {
  key: string;
  label: string;
  /** none = 不发心跳；in-progress = IN_PROGRESS + callbackAfterSeconds；extend-lease = IN_PROGRESS + extendLease: true */
  mode: HeartbeatMode;
  callbackAfterSeconds: number | null;
}

export interface ForeignPoll {
  atSec: number;
  taskId: string;
  sameTask: boolean;
  retryCount?: number;
}

export type HeartbeatVerdict =
  | 'SAFE'
  | 'DUPLICATE_DELIVERY'
  | 'TIMED_OUT_AND_RETRIED'
  | 'BASELINE_TIMEOUT_OBSERVED'
  | 'BASELINE_NO_TIMEOUT';

export interface HeartbeatResult {
  variant: HeartbeatVariant;
  workflowId: string;
  originalTaskId: string;
  heartbeatsSent: number;
  heartbeatNonOk: number[];
  foreignPolls: ForeignPoll[];
  completeHttpStatus: number;
  instances: Array<{ taskId: string; status: string; retryCount?: number; pollCount?: number; workerId?: string }>;
  originalFinalStatus: string;
  workflowFinalStatus: string;
  verdict: HeartbeatVerdict;
}

export function heartbeatVariants(cfg: HeartbeatConfig): HeartbeatVariant[] {
  const short = Math.max(1, Math.floor(cfg.heartbeatEverySeconds / 2));
  return [
    { key: 'none', label: '不发心跳（基线）', mode: 'none', callbackAfterSeconds: null },
    { key: 'cb0', label: '心跳，callbackAfterSeconds=0', mode: 'in-progress', callbackAfterSeconds: 0 },
    { key: 'cbshort', label: `心跳，callbackAfterSeconds=${short}（小于心跳周期）`, mode: 'in-progress', callbackAfterSeconds: short },
    {
      key: 'cbrt',
      label: `心跳，callbackAfterSeconds=${cfg.responseTimeoutSeconds}（等于 responseTimeoutSeconds）`,
      mode: 'in-progress',
      callbackAfterSeconds: cfg.responseTimeoutSeconds,
    },
    { key: 'extend', label: '心跳，extendLease: true', mode: 'extend-lease', callbackAfterSeconds: null },
  ];
}

/** 报告中用来指代变体的心跳参数 */
export function describeHeartbeat(v: HeartbeatVariant): string {
  if (v.mode === 'extend-lease') return 'extendLease';
  if (v.mode === 'in-progress') return `callbackAfterSeconds=${v.callbackAfterSeconds}`;
  return '不发心跳';
}

export async function runHeartbeatVariant(
  rest: ConductorRest,
  registry: Registry,
  prefix: string,
  v: HeartbeatVariant,
  cfg: HeartbeatConfig,
): Promise<HeartbeatResult> {
  const taskType = `${prefix}_hb_${v.key}`;
  const wfName = await registry.setupSingleTask(taskType, {
    retryCount: 3,
    responseTimeoutSeconds: cfg.responseTimeoutSeconds,
    timeoutSeconds: Math.max(cfg.observeSeconds * 3, 600),
  });
  const workflowId = await rest.startWorkflow(wfName);
  const original = await pollUntil(rest, taskType, 'worker-A');
  if (!original) throw new Error(`[${v.key}] 30 秒内未拉到任务`);
  log(`[heartbeat:${v.key}] worker-A 拿到 ${original.taskId}，观察 ${cfg.observeSeconds}s`);

  const t0 = Date.now();
  let heartbeatsSent = 0;
  const heartbeatNonOk: number[] = [];
  const foreignPolls: ForeignPoll[] = [];
  let nextHeartbeat = t0;

  while (Date.now() - t0 < cfg.observeSeconds * 1000) {
    if (v.mode !== 'none' && Date.now() >= nextHeartbeat) {
      const r = await rest.updateTask({
        workflowInstanceId: workflowId,
        taskId: original.taskId,
        workerId: 'worker-A',
        status: 'IN_PROGRESS',
        ...(v.mode === 'extend-lease'
          ? { extendLease: true }
          : { callbackAfterSeconds: v.callbackAfterSeconds ?? 0 }),
        outputData: { heartbeat: heartbeatsSent },
      });
      heartbeatsSent++;
      if (r.status >= 300) heartbeatNonOk.push(r.status);
      nextHeartbeat += cfg.heartbeatEverySeconds * 1000;
    }
    const p = await rest.poll(taskType, 'worker-B');
    if (p) {
      foreignPolls.push({
        atSec: Math.round((Date.now() - t0) / 1000),
        taskId: p.taskId,
        sameTask: p.taskId === original.taskId,
        retryCount: p.retryCount,
      });
      log(`[heartbeat:${v.key}] worker-B 在 +${foreignPolls.at(-1)!.atSec}s 拉到 ${p.taskId}${p.taskId === original.taskId ? '（同一任务！）' : ''}`);
    }
    await sleep(1000);
  }

  // worker-A 结束执行：尝试完成原任务
  const done = await rest.updateTask({
    workflowInstanceId: workflowId,
    taskId: original.taskId,
    workerId: 'worker-A',
    status: 'COMPLETED',
    outputData: { done: true },
  });
  await sleep(1500);

  const wf = await rest.getWorkflow(workflowId, true);
  const instances = (wf.tasks ?? [])
    .filter((t) => t.referenceTaskName === 't1')
    .map((t) => ({ taskId: t.taskId, status: t.status, retryCount: t.retryCount, pollCount: t.pollCount, workerId: t.workerId }));
  const originalFinalStatus = instances.find((i) => i.taskId === original.taskId)?.status ?? 'UNKNOWN';
  if (wf.status === 'RUNNING') await rest.terminate(workflowId, 'cas-verify cleanup');

  const duplicate = foreignPolls.some((f) => f.sameTask);
  const retried = instances.length > 1 || foreignPolls.some((f) => !f.sameTask);
  const timedOut = originalFinalStatus === 'TIMED_OUT';

  let verdict: HeartbeatVerdict;
  if (v.mode === 'none') verdict = retried || timedOut ? 'BASELINE_TIMEOUT_OBSERVED' : 'BASELINE_NO_TIMEOUT';
  else if (duplicate) verdict = 'DUPLICATE_DELIVERY';
  else if (retried || timedOut) verdict = 'TIMED_OUT_AND_RETRIED';
  else verdict = 'SAFE';

  return {
    variant: v,
    workflowId,
    originalTaskId: original.taskId,
    heartbeatsSent,
    heartbeatNonOk,
    foreignPolls,
    completeHttpStatus: done.status,
    instances,
    originalFinalStatus,
    workflowFinalStatus: wf.status,
    verdict,
  };
}
