/**
 * 附加探测：Task Log 读写、TaskDef 是否持久化 inputSchema / outputSchema 字段。
 * schema 探测只能说明字段是否被保存，不代表服务端会据此校验。
 */
import type { ConductorRest } from '../rest.js';
import { pollUntil, taskDef, type Registry } from '../defs.js';

export interface ProbeResult {
  taskLog: { writeHttp: number; readHttp: number; roundTrip: boolean };
  schema: { registerHttp: number; registerBody: string; persistedKeys: string[] };
}

export async function runProbes(rest: ConductorRest, registry: Registry, prefix: string): Promise<ProbeResult> {
  // Task Log
  const type = `${prefix}_log`;
  const wfName = await registry.setupSingleTask(type);
  const wid = await rest.startWorkflow(wfName);
  const t = await pollUntil(rest, type, 'worker-probe');
  if (!t) throw new Error('log 探测：30 秒内未拉到任务');
  const marker = `cas-verify-log-${Date.now()}`;
  const w = await rest.addTaskLog(t.taskId, marker);
  const rd = await rest.getTaskLogs(t.taskId);
  const roundTrip = Array.isArray(rd.data) && rd.data.some((l) => typeof l.log === 'string' && l.log.includes(marker));
  await rest.updateTask({ workflowInstanceId: wid, taskId: t.taskId, workerId: 'worker-probe', status: 'COMPLETED' });

  // TaskDef schema 字段
  const sname = `${prefix}_schema`;
  const reg = await rest.request('POST', '/metadata/taskdefs', [
    taskDef(sname, {
      extra: {
        inputSchema: { name: `${sname}_in`, version: 1, type: 'JSON' },
        outputSchema: { name: `${sname}_out`, version: 1, type: 'JSON' },
        enforceSchema: true,
      },
    }),
  ]);
  if (reg.status < 300) registry.taskDefs.push(sname);
  const back = await rest.getTaskDef(sname);
  const persistedKeys = ['inputSchema', 'outputSchema', 'enforceSchema'].filter(
    (k) => back.data && typeof back.data === 'object' && back.data[k] !== undefined && back.data[k] !== null,
  );

  return {
    taskLog: { writeHttp: w.status, readHttp: rd.status, roundTrip },
    schema: { registerHttp: reg.status, registerBody: reg.text.slice(0, 300), persistedKeys },
  };
}
