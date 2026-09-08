/**
 * 一键验证：跑一遍完整流程，逐条给出 PASS / FAIL，并写出可直接贴回来的报告。
 *
 *   pnpm --filter @ca-example/minimal-agent verify
 *
 * 需要一个**已在运行的** Conductor OSS（≥ 3.10.7）：
 *   CONDUCTOR_SERVER_URL=http://your-conductor:8080/api pnpm --filter … verify
 *
 * 不需要 Redis，不需要 LLM key（默认用确定性的脚本化模型）。
 * 退出码：全通过 0，有 FAIL 非 0 —— 可直接进 CI。
 */
import { writeFileSync } from 'node:fs';
import { TASK_TYPE, counters, orderAgentSpec } from './agent.js';
import {
  CONDUCTOR_URL,
  buildWiring,
  getTaskLogs,
  getWorkflow,
  registerMetadata,
  runPreflight,
  startPolling,
  startRun,
} from './conductor.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESPONSE_TIMEOUT_SECONDS = orderAgentSpec.conductor?.responseTimeoutSeconds ?? 60;

interface Check {
  id: string;
  what: string;
  ref: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  actual: string;
}

const checks: Check[] = [];
let failed = 0;
let serverVersion = '未知';

function record(
  id: string,
  what: string,
  ref: string,
  ok: boolean | 'skip',
  actual: string,
): void {
  const status = ok === 'skip' ? 'SKIP' : ok ? 'PASS' : 'FAIL';
  if (status === 'FAIL') failed += 1;
  checks.push({ id, what, ref, status, actual });
  const mark = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '➖';
  console.log(`${mark} ${id}  ${what}\n      实测：${actual}`);
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${CONDUCTOR_URL.replace(/\/$/, '')}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function main(): Promise<void> {
  console.log(`\n验证目标：${CONDUCTOR_URL}\n${'─'.repeat(72)}\n`);

  // ── 0. 服务端可达 ──
  try {
    const cfg = (await fetchJson('/admin/config')) as Record<string, unknown>;
    serverVersion = String(cfg['version'] ?? '未知');
    record('S1', '服务端可达且能读到版本', '§6.8', true, `version = ${serverVersion}`);
  } catch (err) {
    record('S1', '服务端可达且能读到版本', '§6.8', false, String((err as Error).message));
    console.error('\n连不上 Conductor，后面的验证无法进行。检查 CONDUCTOR_SERVER_URL。');
    finish(null);
    return;
  }

  // ── 1. 注册 + 启动自检 ──
  // strict=false：负向验证（doc §6.2 / §6.3）时要把问题记成红色检查项，而不是抛出去
  await registerMetadata();
  const report = await runPreflight(false);
  record(
    'P1',
    '启动自检：服务端支持 extendLease',
    '§6.8 / ADR-0022',
    report.extendLeaseSupported !== false,
    `extendLeaseSupported = ${String(report.extendLeaseSupported)}`,
  );
  record(
    'P2',
    '启动自检：线上 TaskDef 与本地推导零漂移',
    '§6.8',
    report.drift.length === 0,
    report.drift.length === 0 ? '无漂移' : JSON.stringify(report.drift),
  );
  record('P3', '启动自检整体通过（无致命问题）', '§6.8', report.ok, `problems = ${report.problems.length}`);

  // ── 2. TaskDef 注册值 ──
  const def = (await fetchJson(`/metadata/taskdefs/${TASK_TYPE}`)) as {
    timeoutSeconds: number;
    responseTimeoutSeconds: number;
    retryCount: number;
  };
  record(
    'T1',
    'timeoutSeconds = 0（长任务不设总时长上限）',
    '§6.6',
    def.timeoutSeconds === 0,
    `timeoutSeconds = ${def.timeoutSeconds}`,
  );
  record(
    'T2',
    `responseTimeoutSeconds = ${RESPONSE_TIMEOUT_SECONDS}（崩溃检测灵敏度）`,
    '§6.6',
    def.responseTimeoutSeconds === RESPONSE_TIMEOUT_SECONDS,
    `responseTimeoutSeconds = ${def.responseTimeoutSeconds}`,
  );
  record(
    'T3',
    'retryCount > 0（worker 崩溃会消耗它）',
    '§6.6',
    def.retryCount > 0,
    `retryCount = ${def.retryCount}`,
  );

  // ── 3. 跑一次 ──
  counters.modelCalls = 0;
  counters.toolCalls = 0;

  let wiring: Awaited<ReturnType<typeof buildWiring>>;
  try {
    wiring = await buildWiring();
  } catch (err) {
    // 本地配置错误（如 responseTimeoutSeconds < 1.25）会在这里被 compileAgentWorker 拒绝。
    // 这是**设计要的行为**，但对本脚本而言就跑不下去了 —— 记成红色并收尾。
    record('W1', 'worker 能被编译出来（本地配置校验）', '§5.2', false, String((err as Error).message));
    finish(null);
    return;
  }
  const manager = await startPolling(wiring);

  const workflowId = await startRun('查一下订单 A-1001 到哪了');
  console.log(`\n   workflowId = ${workflowId}，等待完成…\n`);

  const deadline = Date.now() + 180_000;
  const trace: string[] = [];
  let wf = await getWorkflow(workflowId);
  let maxPollCount = 0;
  try {
    while (Date.now() < deadline && (wf.status === 'RUNNING' || wf.status === undefined)) {
      const t = wf.tasks?.[0];
      if (t?.status && trace[trace.length - 1] !== t.status) trace.push(t.status);
      if (t?.pollCount) maxPollCount = Math.max(maxPollCount, t.pollCount);
      await sleep(500);
      wf = await getWorkflow(workflowId);
    }
  } finally {
    // 无论轮询是否出错，都要把 poll 循环停掉，否则进程退不出去
    manager.stopPolling();
    await wiring.close();
  }
  const task = wf.tasks?.[0];
  if (task?.status && trace[trace.length - 1] !== task.status) trace.push(task.status);
  if (task?.pollCount) maxPollCount = Math.max(maxPollCount, task.pollCount);
  const durationMs = (task?.endTime ?? 0) - (task?.startTime ?? 0);

  record('R1', '工作流跑完且成功', '§5.1', wf.status === 'COMPLETED', `status = ${wf.status}`);
  record(
    'R2',
    `⭐ 运行时长 > responseTimeoutSeconds 却没被判超时 → **心跳生效**`,
    '§5.2 / ADR-0022',
    durationMs > RESPONSE_TIMEOUT_SECONDS * 1000 && task?.status === 'COMPLETED',
    `运行 ${(durationMs / 1000).toFixed(1)}s vs responseTimeout ${RESPONSE_TIMEOUT_SECONDS}s，任务状态 ${task?.status}`,
  );
  record(
    'R3',
    '⭐ pollCount = 1 且 retryCount = 0 → **从头到尾同一个 worker**',
    '§2.2 / §5.3',
    maxPollCount === 1 && (task?.retryCount ?? 0) === 0,
    `pollCount = ${maxPollCount}, retryCount = ${task?.retryCount ?? 0}`,
  );
  record(
    'R4',
    '状态轨迹里没有 SCHEDULED（那是 callback 模式的特征）',
    '§2.2',
    !trace.includes('SCHEDULED'),
    trace.join(' → ') || '（没采到中间态）',
  );
  record(
    'R5',
    '⭐ 一次执行只跑一遍：模型 2 次 / 工具 1 次',
    '§5.1',
    counters.modelCalls === 2 && counters.toolCalls === 1,
    `模型 ${counters.modelCalls} 次 / 工具 ${counters.toolCalls} 次`,
  );

  const out = wf.output ?? {};
  record(
    'O1',
    'outputData 带回结果、进展与用量',
    '§6.5',
    Boolean(out['answer']) && Boolean(out['progress']) && Boolean(out['usage']),
    `answer=${Boolean(out['answer'])} progress=${Boolean(out['progress'])} usage=${Boolean(out['usage'])}`,
  );
  record(
    'O2',
    'output.taskId == 任务的 taskId（运行标识就是 taskId）',
    'ADR-0020',
    out['taskId'] === task?.taskId,
    `${String(out['taskId'])} vs ${String(task?.taskId)}`,
  );
  const usage = out['usage'] as { costUsd?: number } | undefined;
  record(
    'O3',
    '成本被记账',
    '§4.3',
    (usage?.costUsd ?? 0) > 0,
    `costUsd = ${String(usage?.costUsd)}`,
  );

  // ── 4. 运行中的进展通道 ──
  const logs = task?.taskId ? await getTaskLogs(task.taskId) : [];
  if (logs.length === 0) {
    record(
      'L1',
      'Task Log 通道（运行中唯一可见的进展）',
      '§10.4',
      'skip',
      '空 —— 该部署未启用 task log 索引，属**预期降级**（终态 outputData.progress 仍有值）',
    );
  } else {
    const tooLong = logs.filter((l) => (l.log ?? '').length > 512);
    record(
      'L1',
      'Task Log 通道有内容且每行 ≤ 512 字符',
      '§10.4',
      tooLong.length === 0,
      `${logs.length} 行，最长 ${Math.max(...logs.map((l) => (l.log ?? '').length))} 字符`,
    );
  }

  finish(wf.output ?? {});
}

function finish(output: Record<string, unknown> | null): void {
  const rows = checks
    .map((c) => `| ${c.id} | ${c.status} | ${c.what} | \`${c.actual.replace(/\|/g, '\\|')}\` | ${c.ref} |`)
    .join('\n');
  const md = `# M1 验证报告

- 时间：${new Date().toISOString()}
- 服务端：\`${CONDUCTOR_URL}\` · version \`${serverVersion || '未知'}\`
- 结果：**${failed === 0 ? '全部通过' : `${failed} 项未通过`}**（${checks.length} 项检查）

| # | 结果 | 检查项 | 实测 | 对应设计 |
|---|---|---|---|---|
${rows}

${
  output
    ? `<details><summary>本次运行的完整 output</summary>\n\n\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\`\n\n</details>`
    : '> 本次没有跑到实际运行 —— 上面有检查项在此之前就失败了。'
}
`;
  const path = new URL('../verification-report.md', import.meta.url).pathname;
  writeFileSync(path, md, 'utf8');

  console.log(`\n${'─'.repeat(72)}`);
  const connectivity = checks.some((c) => c.id === 'S1' && c.status === 'FAIL');
  console.log(
    failed === 0
      ? `\n全部 ${checks.length} 项通过。`
      : connectivity
        ? `\n连不上服务端，验证没有真正开始 —— 先确认 CONDUCTOR_SERVER_URL 与网络。`
        : `\n${failed} / ${checks.length} 项未通过 —— 那是设计或实现的真实缺陷，需要修。`,
  );
  console.log(`报告已写入：${path}\n直接把这个文件贴回来即可。\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\n验证过程本身出错了：', err);
  process.exitCode = 1;
});
