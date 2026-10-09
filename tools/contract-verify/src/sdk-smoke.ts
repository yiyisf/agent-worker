/**
 * 官方 JS SDK 冒烟：用 TaskManager 跑通 poll → execute → updateTask。
 * 与 verify.ts 分开，因为官方 SDK 不同版本的 API 命名可能不同；锁定版本时若编译失败，按实际 API 调整此文件。
 */
import { orkesConductorClient, TaskManager } from '@io-orkes/conductor-javascript';
import { ConductorRest } from './rest.js';
import { Registry } from './defs.js';
import { log, sleep } from './util.js';

async function main(): Promise<number> {
  const serverUrl = process.env.CONDUCTOR_URL;
  if (!serverUrl) throw new Error('请设置 CONDUCTOR_URL');
  const rest = new ConductorRest(serverUrl);
  const registry = new Registry(rest);
  const type = `cas_sdk_smoke_${Date.now().toString(36)}`;
  const wfName = await registry.setupSingleTask(type);

  const client = await orkesConductorClient({ serverUrl });
  const manager = new TaskManager(
    client,
    [
      {
        taskDefName: type,
        execute: async (task: { inputData?: Record<string, unknown> }) => ({
          status: 'COMPLETED',
          outputData: { echo: task.inputData ?? {}, via: 'TaskManager' },
        }),
      },
    ] as never,
    { options: { pollInterval: 200, concurrency: 1 } } as never,
  );

  try {
    manager.startPolling();
    const wid = await rest.startWorkflow(wfName, { hello: 'cas' });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const wf = await rest.getWorkflow(wid, false);
      if (wf.status !== 'RUNNING') {
        log(`工作流 ${wid} 结束：${wf.status}`);
        return wf.status === 'COMPLETED' ? 0 : 1;
      }
      await sleep(500);
    }
    log('30 秒内未完成：TaskManager 未能拉取或上报');
    await rest.terminate(wid, 'cas-verify cleanup');
    return 1;
  } finally {
    manager.stopPolling();
    await registry.cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
