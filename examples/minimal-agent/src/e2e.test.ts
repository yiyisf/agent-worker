/**
 * 端到端验证 —— M1 的出口标准（architecture.md §14）。
 *
 * 需要真实的 Conductor + Redis。**没有就跳过而不是失败**：
 *   docker compose -f examples/minimal-agent/docker-compose.yml up -d
 *   CONDUCTOR_SERVER_URL=http://localhost:8080/api pnpm test
 *
 * 断言的是异步化模型里最要紧的三条，而不是「能跑就行」：
 *   1. 任务确实被 callback 交还过（execute 不阻塞，agent 在后台跑）
 *   2. 无论 callback 几次，**一次执行只跑一遍** —— 真实调用次数不随 callback 次数增长
 *   3. 运行中能看见进展：outputData.progress（权威）+ Task Log（尽力而为）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { TASK_TYPE, counters } from './agent.js';
import {
  CONDUCTOR_URL,
  REDIS_URL,
  buildWiring,
  getTaskLogs,
  getWorkflow,
  registerMetadata,
  startPolling,
  startRun,
  type Wiring,
} from './conductor.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${CONDUCTOR_URL.replace(/\/api\/?$/, '')}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return false;
    const redis = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });
    await redis.connect();
    await redis.ping();
    await redis.quit();
    return true;
  } catch {
    return false;
  }
}

const live = await reachable();
if (!live) {
  console.warn(
    `[e2e] 跳过：连不上 Conductor(${CONDUCTOR_URL}) 或 Redis(${REDIS_URL})。` +
      ' 起法见 examples/minimal-agent/README.md',
  );
}

let wiring: Wiring | undefined;
let manager: Awaited<ReturnType<typeof startPolling>> | undefined;

async function runToCompletion(question: string, timeoutMs = 90_000) {
  const workflowId = await startRun(question);
  const deadline = Date.now() + timeoutMs;
  let wf = await getWorkflow(workflowId);
  let maxPollCount = 0;
  let sawProgress = false;

  while (Date.now() < deadline && (wf.status === 'RUNNING' || wf.status === undefined)) {
    const t = wf.tasks?.[0];
    if (t?.pollCount) maxPollCount = Math.max(maxPollCount, t.pollCount);
    if (t?.outputData?.progress) sawProgress = true;
    await sleep(400);
    wf = await getWorkflow(workflowId);
  }
  const t = wf.tasks?.[0];
  if (t?.pollCount) maxPollCount = Math.max(maxPollCount, t.pollCount);
  return { workflowId, wf, maxPollCount, sawProgress };
}

describe.skipIf(!live)('minimal-agent 端到端（需要 Conductor + Redis）', () => {
  beforeAll(async () => {
    await registerMetadata();
    wiring = await buildWiring();
    manager = await startPolling(wiring);
  }, 60_000);

  afterAll(async () => {
    manager?.stopPolling();
    await wiring?.close();
  });

  it('跑通一次运行：异步执行、多次 callback、只跑一遍', async () => {
    counters.modelCalls = 0;
    counters.toolCalls = 0;

    const { wf, maxPollCount, sawProgress } = await runToCompletion('查一下订单 A-1001 到哪了');

    // ── 基本：跑完且成功 ──
    expect(wf.status).toBe('COMPLETED');
    expect(String(wf.output?.answer ?? '')).toContain('A-1001');

    // ── 1. 任务被 callback 交还过：pollCount>1 说明同一个 taskId 被反复取回 ──
    //    （模型第一步有 3 秒延迟，callbackAfterSeconds=2，所以至少两次）
    expect(maxPollCount).toBeGreaterThan(1);

    // ── 2. 一次执行只跑一遍：这是异步化模型的核心断言 ──
    //    假模型逻辑上就是两步；无论被 callback 几次，真实调用次数都不变
    expect(counters.modelCalls).toBe(2);
    expect(counters.toolCalls).toBe(1);

    // ── 3. 进展可见：权威通道 ──
    const progress = wf.output?.progress as { step?: number } | undefined;
    expect(progress?.step).toBeGreaterThan(0);
    expect(sawProgress || progress !== undefined).toBe(true);

    // 成本被记上了（示例配了 pricing）
    const usage = wf.output?.usage as { costUsd?: number } | undefined;
    expect(usage?.costUsd).toBeGreaterThan(0);

    // runId 就是 taskId —— 同一次执行的所有 callback 共享它（ADR-0020）
    expect(wf.output?.runId).toBe(wf.tasks?.[0]?.taskId);
  }, 120_000);

  it('Task Log 通道：有索引就看得到进展，没索引则优雅降级', async () => {
    const { wf } = await runToCompletion('再查一次 A-1001');
    expect(wf.status).toBe('COMPLETED');

    const taskId = wf.tasks?.[0]?.taskId;
    expect(taskId).toBeTruthy();
    const logs = await getTaskLogs(taskId!);

    if (logs.length === 0) {
      // 该部署未启用 task log 索引（NoopIndexDAO）——这是**预期内的降级**，不是失败。
      console.warn('[e2e] 该部署未保存 task log（indexing 未启用），通道二降级 —— 符合 §10.4 设计');
      return;
    }
    // 日志是给人看的一行文本，不该是 payload
    for (const l of logs) {
      expect(typeof l.log).toBe('string');
      expect(l.log!.length).toBeLessThanOrEqual(512);
    }
  }, 120_000);

  it('TaskDef 已按注册期规则写入：长任务不设总时长上限', async () => {
    const res = await fetch(`${CONDUCTOR_URL}/metadata/taskdefs/${TASK_TYPE}`);
    expect(res.ok).toBe(true);
    const def = (await res.json()) as {
      responseTimeoutSeconds: number;
      retryCount: number;
      timeoutSeconds: number;
    };
    // 0 = checkTaskTimeout 直接 return；跑飞由 worker 自己的 wallClockMs 兜底
    expect(def.timeoutSeconds).toBe(0);
    // 保持服务端默认：调小会抢在队列 unack 前判 TIMED_OUT 并消耗一次 retryCount
    expect(def.responseTimeoutSeconds).toBe(3600);
    expect(def.retryCount).toBeGreaterThan(0);
  }, 30_000);
});
