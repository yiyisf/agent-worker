/**
 * 问题 3：task output 体积超过多少会被外部化或拒绝？
 * 逐档提交不同大小的 outputData，记录 HTTP 结果、任务最终状态、是否写入外部存储。
 */
import type { ConductorRest } from '../rest.js';
import { pollUntil, type Registry } from '../defs.js';
import { log, sleep } from '../util.js';

export interface PayloadProbe {
  sizeKB: number;
  updateHttp: number;
  updateBody: string;
  taskStatus: string;
  reasonForIncompletion?: string;
  externalOutputPayloadStoragePath?: string;
  storedInlineBytes?: number;
  workflowStatus: string;
}

export async function runPayload(
  rest: ConductorRest,
  registry: Registry,
  prefix: string,
  sizesKB: number[],
): Promise<PayloadProbe[]> {
  const type = `${prefix}_payload`;
  const wfName = await registry.setupSingleTask(type, { retryCount: 0 });
  const results: PayloadProbe[] = [];

  for (const sizeKB of sizesKB) {
    const workflowId = await rest.startWorkflow(wfName);
    const t = await pollUntil(rest, type, 'worker-payload');
    if (!t) throw new Error(`payload ${sizeKB}KB：30 秒内未拉到任务`);
    const r = await rest.updateTask({
      workflowInstanceId: workflowId,
      taskId: t.taskId,
      workerId: 'worker-payload',
      status: 'COMPLETED',
      outputData: { blob: 'x'.repeat(sizeKB * 1024) },
    });
    await sleep(1500);
    const task = await rest.getTask(t.taskId);
    const wf = await rest.getWorkflow(workflowId, false);
    if (wf.status === 'RUNNING') await rest.terminate(workflowId, 'cas-verify cleanup');
    const blob = task.outputData?.blob;
    results.push({
      sizeKB,
      updateHttp: r.status,
      updateBody: r.text.slice(0, 300),
      taskStatus: task.status,
      reasonForIncompletion: task.reasonForIncompletion,
      externalOutputPayloadStoragePath: task.externalOutputPayloadStoragePath,
      storedInlineBytes: typeof blob === 'string' ? blob.length : undefined,
      workflowStatus: wf.status,
    });
    log(`[payload] ${sizeKB}KB -> HTTP ${r.status}, task ${task.status}${task.externalOutputPayloadStoragePath ? '（已外部化）' : ''}`);
  }
  return results;
}
