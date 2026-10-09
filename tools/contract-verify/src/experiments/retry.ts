/**
 * 问题 2：Conductor 重试是否生成新 taskId？FAILED_WITH_TERMINAL_ERROR 是否跳过重试？
 * 结论决定 SDK 的“执行 ID”与“任务键 / 幂等键”如何划分。
 */
import type { ConductorRest, TaskResultStatus } from '../rest.js';
import { pollUntil, type Registry } from '../defs.js';
import { log, sleep } from '../util.js';

export interface RetryAttempt {
  attempt: number;
  taskId: string;
  retryCount?: number;
  retriedTaskId?: string;
  action: TaskResultStatus;
  updateHttp: number;
}

export interface RetryResult {
  normal: {
    workflowId: string;
    attempts: RetryAttempt[];
    distinctTaskIds: boolean;
    retryCountSequence: Array<number | undefined>;
    workflowStatus: string;
    finalInstances: Array<{ taskId: string; status: string; retryCount?: number; retriedTaskId?: string }>;
  };
  terminal: {
    workflowId: string;
    taskId: string;
    updateHttp: number;
    retriedAfterTerminal: boolean;
    taskStatus: string;
    workflowStatus: string;
  };
}

export async function runRetry(rest: ConductorRest, registry: Registry, prefix: string): Promise<RetryResult> {
  // 普通重试：失败两次后成功
  const type = `${prefix}_retry`;
  const wfName = await registry.setupSingleTask(type, { retryCount: 2, retryLogic: 'FIXED', retryDelaySeconds: 1 });
  const workflowId = await rest.startWorkflow(wfName);
  const plan: TaskResultStatus[] = ['FAILED', 'FAILED', 'COMPLETED'];
  const attempts: RetryAttempt[] = [];

  for (let i = 0; i < plan.length; i++) {
    const t = await pollUntil(rest, type, 'worker-retry', 60_000);
    if (!t) throw new Error(`普通重试：第 ${i + 1} 次尝试 60 秒内未拉到任务`);
    const r = await rest.updateTask({
      workflowInstanceId: workflowId,
      taskId: t.taskId,
      workerId: 'worker-retry',
      status: plan[i],
      reasonForIncompletion: plan[i] === 'FAILED' ? `cas-verify simulated failure #${i + 1}` : undefined,
      outputData: { attempt: i + 1 },
    });
    attempts.push({
      attempt: i + 1,
      taskId: t.taskId,
      retryCount: t.retryCount,
      retriedTaskId: t.retriedTaskId,
      action: plan[i],
      updateHttp: r.status,
    });
    log(`[retry] 第 ${i + 1} 次：${t.taskId} retryCount=${t.retryCount} -> ${plan[i]}`);
  }
  await sleep(1500);
  const wf = await rest.getWorkflow(workflowId, true);
  if (wf.status === 'RUNNING') await rest.terminate(workflowId, 'cas-verify cleanup');

  // 终态错误：不应再重试
  const ttype = `${prefix}_terminal`;
  const twfName = await registry.setupSingleTask(ttype, { retryCount: 2, retryLogic: 'FIXED', retryDelaySeconds: 1 });
  const twid = await rest.startWorkflow(twfName);
  const t1 = await pollUntil(rest, ttype, 'worker-retry', 60_000);
  if (!t1) throw new Error('终态错误：60 秒内未拉到任务');
  const tr = await rest.updateTask({
    workflowInstanceId: twid,
    taskId: t1.taskId,
    workerId: 'worker-retry',
    status: 'FAILED_WITH_TERMINAL_ERROR',
    reasonForIncompletion: 'cas-verify terminal error',
  });
  const again = await pollUntil(rest, ttype, 'worker-retry', 10_000);
  const twf = await rest.getWorkflow(twid, true);
  const tStatus = (twf.tasks ?? []).find((t) => t.taskId === t1.taskId)?.status ?? 'UNKNOWN';
  if (twf.status === 'RUNNING') await rest.terminate(twid, 'cas-verify cleanup');

  return {
    normal: {
      workflowId,
      attempts,
      distinctTaskIds: new Set(attempts.map((a) => a.taskId)).size === attempts.length,
      retryCountSequence: attempts.map((a) => a.retryCount),
      workflowStatus: wf.status,
      finalInstances: (wf.tasks ?? [])
        .filter((t) => t.referenceTaskName === 't1')
        .map((t) => ({ taskId: t.taskId, status: t.status, retryCount: t.retryCount, retriedTaskId: t.retriedTaskId })),
    },
    terminal: {
      workflowId: twid,
      taskId: t1.taskId,
      updateHttp: tr.status,
      retriedAfterTerminal: again !== undefined,
      taskStatus: tStatus,
      workflowStatus: twf.status,
    },
  };
}
