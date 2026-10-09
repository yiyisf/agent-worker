import type { ConductorRest, Task } from './rest.js';
import { sleep } from './util.js';

export const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'cas-verify@example.com';

/** 当前引擎为定制版本：TaskDef 与 WorkflowDef 均必填 nameCn */
export const NAME_CN_PREFIX = process.env.NAME_CN_PREFIX ?? 'CAS契约验证';
const nameCn = (name: string) => `${NAME_CN_PREFIX}-${name}`;

export interface TaskDefOptions {
  retryCount?: number;
  retryLogic?: 'FIXED' | 'EXPONENTIAL_BACKOFF' | 'LINEAR_BACKOFF';
  retryDelaySeconds?: number;
  timeoutSeconds?: number;
  responseTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export function taskDef(name: string, o: TaskDefOptions = {}) {
  return {
    name,
    nameCn: nameCn(name),
    description: 'CAS contract verification (safe to delete)',
    ownerEmail: OWNER_EMAIL,
    retryCount: o.retryCount ?? 0,
    retryLogic: o.retryLogic ?? 'FIXED',
    retryDelaySeconds: o.retryDelaySeconds ?? 1,
    timeoutSeconds: o.timeoutSeconds ?? 600,
    responseTimeoutSeconds: o.responseTimeoutSeconds ?? 60,
    timeoutPolicy: 'RETRY',
    inputKeys: [],
    outputKeys: [],
    ...o.extra,
  };
}

export function singleTaskWorkflow(name: string, taskName: string) {
  return {
    name,
    nameCn: nameCn(name),
    version: 1,
    schemaVersion: 2,
    description: 'CAS contract verification (safe to delete)',
    ownerEmail: OWNER_EMAIL,
    timeoutPolicy: 'ALERT_ONLY',
    timeoutSeconds: 0,
    restartable: true,
    tasks: [{ name: taskName, taskReferenceName: 't1', type: 'SIMPLE', inputParameters: {} }],
  };
}

/** 记录本次创建的元数据，结束时统一清理 */
export class Registry {
  readonly taskDefs: string[] = [];
  readonly workflowDefs: string[] = [];

  constructor(private readonly rest: ConductorRest) {}

  async setupSingleTask(taskType: string, o: TaskDefOptions = {}): Promise<string> {
    await this.rest.registerTaskDefs([taskDef(taskType, o)]);
    this.taskDefs.push(taskType);
    const wfName = `${taskType}_wf`;
    await this.rest.upsertWorkflowDefs([singleTaskWorkflow(wfName, taskType)]);
    this.workflowDefs.push(wfName);
    return wfName;
  }

  async cleanup(): Promise<void> {
    for (const wf of this.workflowDefs) await this.rest.deleteWorkflowDef(wf);
    for (const td of this.taskDefs) await this.rest.deleteTaskDef(td);
  }
}

export async function pollUntil(
  rest: ConductorRest,
  taskType: string,
  workerId: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<Task | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = await rest.poll(taskType, workerId);
    if (t) return t;
    await sleep(intervalMs);
  }
  return undefined;
}
