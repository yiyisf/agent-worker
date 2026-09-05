/**
 * 可执行入口：注册元数据 → 起 worker → 触发一次运行 → 打印结果。
 *
 *   pnpm --filter @ca-example/minimal-agent start
 *
 * 需要先起 Conductor 与 Redis：
 *   docker compose -f examples/minimal-agent/docker-compose.yml up -d
 */
import { counters } from './agent.js';
import {
  buildWiring,
  getTaskLogs,
  getWorkflow,
  registerMetadata,
  startPolling,
  startRun,
} from './conductor.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log('① 注册 TaskDef 与工作流定义…');
  await registerMetadata();

  console.log('② 启动 worker（poll 循环由官方 TaskManager 托管）…');
  const wiring = await buildWiring();
  const manager = await startPolling(wiring);

  console.log('③ 触发一次运行…');
  const workflowId = await startRun('查一下订单 A-1001 到哪了');
  console.log('   workflowId =', workflowId);

  const deadline = Date.now() + 120_000;
  let wf = await getWorkflow(workflowId);
  while (Date.now() < deadline && (wf.status === 'RUNNING' || wf.status === undefined)) {
    await sleep(1_000);
    wf = await getWorkflow(workflowId);
    const t = wf.tasks?.[0];
    if (t) process.stdout.write(`   task=${t.status ?? '?'}  `);
  }
  console.log();

  console.log('④ 结果');
  console.log('   status  =', wf.status);
  console.log('   output  =', JSON.stringify(wf.output, null, 2));
  console.log(`   真实调用：模型 ${counters.modelCalls} 次 / 工具 ${counters.toolCalls} 次`);

  const taskId = wf.tasks?.[0]?.taskId;
  if (taskId) {
    const logs = await getTaskLogs(taskId);
    console.log('⑤ Conductor Task Log（进展的尽力而为通道）');
    if (logs.length === 0) {
      console.log('   （空 —— 该部署可能未启用 task log 索引，属预期降级，见 §10.4）');
    }
    for (const l of logs) console.log('   ·', l.log);
  }

  manager.stopPolling();
  await wiring.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
