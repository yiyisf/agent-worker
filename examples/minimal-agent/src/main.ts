/**
 * 可执行入口：注册元数据 → 起 worker → 触发一次运行 → 打印结果。
 *
 *   pnpm --filter @ca-example/minimal-agent start
 *
 * 只需要 Conductor（不需要 Redis）：
 *   docker compose -f examples/minimal-agent/docker-compose.yml up -d
 */
import { counters } from './agent.js';
import {
  buildWiring,
  runPreflight,
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

  console.log('② 启动自检（服务端版本 / TaskDef 漂移）…');
  const report = await runPreflight();
  console.log(
    `   服务端 ${report.serverVersion ?? '版本未知'} · extendLease ${
      report.extendLeaseSupported === true ? '可用' : String(report.extendLeaseSupported)
    } · 漂移 ${report.drift.length} 项`,
  );

  console.log('③ 启动 worker（poll 循环与 extendLease 心跳都由官方 SDK 托管）…');
  const wiring = await buildWiring();
  const manager = await startPolling(wiring);

  console.log('④ 触发一次运行…');
  const workflowId = await startRun('查一下订单 A-1001 到哪了');
  console.log('   workflowId =', workflowId);

  const deadline = Date.now() + 180_000;
  let wf = await getWorkflow(workflowId);
  const seen: string[] = [];
  while (Date.now() < deadline && (wf.status === 'RUNNING' || wf.status === undefined)) {
    await sleep(1_000);
    wf = await getWorkflow(workflowId);
    const t = wf.tasks?.[0];
    if (t?.status) seen.push(`${t.status}(poll=${t.pollCount ?? '?'})`);
  }
  console.log('   任务状态轨迹：', seen.join(' → ') || '（太快，没采到中间态）');

  const t = wf.tasks?.[0];
  const durationMs = (t?.endTime ?? 0) - (t?.startTime ?? 0);
  console.log('⑤ 结果');
  console.log('   status  =', wf.status);
  console.log(`   运行时长 = ${(durationMs / 1000).toFixed(1)}s（responseTimeoutSeconds = 5s）`);
  console.log(`   pollCount = ${t?.pollCount ?? '?'} / retryCount = ${t?.retryCount ?? 0}`);
  console.log('   output  =', JSON.stringify(wf.output, null, 2));
  console.log(`   真实调用：模型 ${counters.modelCalls} 次 / 工具 ${counters.toolCalls} 次`);
  console.log('   ↑ 运行时长远超 responseTimeoutSeconds 却没被判超时 = extendLease 心跳生效；');
  console.log('     pollCount=1 且 retryCount=0 = 从头到尾同一个 worker，没被重新分配。');

  const taskId = wf.tasks?.[0]?.taskId;
  if (taskId) {
    const logs = await getTaskLogs(taskId);
    console.log('⑥ Conductor Task Log（extendLease 下唯一的运行中进展通道）');
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
