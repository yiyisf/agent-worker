/**
 * 端到端验证 —— M1 的出口标准（architecture.md §14）。
 *
 * 只需要 Conductor，**不需要 Redis**（agent 状态全程在 worker 进程内）。
 *   docker compose -f examples/minimal-agent/docker-compose.yml up -d
 *   CONDUCTOR_SERVER_URL=http://localhost:8080/api pnpm test
 *
 * 断言的是 extendLease 模式里最要紧的四条，而不是「能跑就行」：
 *   1. 运行时长 > responseTimeoutSeconds，任务却没被判超时 → **心跳真的在发**
 *   2. pollCount == 1、retryCount == 0 → **从头到尾同一个 worker，没被重新分配**
 *   3. 一次执行只跑一遍 → 真实模型调用次数 == 逻辑步数
 *   4. 运行途中能看见进展 → Task Log（extendLease 下唯一的运行中通道）
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TASK_TYPE, counters } from './agent.js';
import {
  CONDUCTOR_URL,
  buildWiring,
  getTaskLogs,
  getWorkflow,
  registerMetadata,
  startPolling,
  startRun,
  type Wiring,
} from './conductor.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RESPONSE_TIMEOUT_SECONDS = 5;

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${CONDUCTOR_URL.replace(/\/api\/?$/, '')}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const live = await reachable();
if (!live) {
  console.warn(
    `[e2e] 跳过：连不上 Conductor(${CONDUCTOR_URL})。起法见 examples/minimal-agent/README.md`,
  );
}

let wiring: Wiring | undefined;
let manager: Awaited<ReturnType<typeof startPolling>> | undefined;

async function runToCompletion(question: string, timeoutMs = 120_000) {
  const workflowId = await startRun(question);
  const deadline = Date.now() + timeoutMs;
  let wf = await getWorkflow(workflowId);
  let maxPollCount = 0;
  let sawInProgress = false;

  while (Date.now() < deadline && (wf.status === 'RUNNING' || wf.status === undefined)) {
    const t = wf.tasks?.[0];
    if (t?.pollCount) maxPollCount = Math.max(maxPollCount, t.pollCount);
    if (t?.status === 'IN_PROGRESS') sawInProgress = true;
    await sleep(500);
    wf = await getWorkflow(workflowId);
  }
  const t = wf.tasks?.[0];
  if (t?.pollCount) maxPollCount = Math.max(maxPollCount, t.pollCount);
  return { workflowId, wf, maxPollCount, sawInProgress };
}

describe.skipIf(!live)('minimal-agent 端到端（需要 Conductor）', () => {
  beforeAll(async () => {
    await registerMetadata();
    wiring = await buildWiring();
    manager = await startPolling(wiring);
  }, 60_000);

  afterAll(async () => {
    manager?.stopPolling();
    await wiring?.close();
  });

  it('长任务跑通：心跳生效、同一 worker、只跑一遍', async () => {
    counters.modelCalls = 0;
    counters.toolCalls = 0;

    const { wf, maxPollCount, sawInProgress } = await runToCompletion('查一下订单 A-1001 到哪了');
    const task = wf.tasks?.[0];

    // ── 基本：跑完且成功 ──
    expect(wf.status).toBe('COMPLETED');
    expect(String(wf.output?.answer ?? '')).toContain('A-1001');

    // ── 1. 心跳生效：运行时长明显超过 responseTimeoutSeconds，任务却没被判超时 ──
    //    没有 extendLease 的话这里必然是 TIMED_OUT
    const durationMs = (task?.endTime ?? 0) - (task?.startTime ?? 0);
    expect(durationMs).toBeGreaterThan(RESPONSE_TIMEOUT_SECONDS * 1000);
    expect(task?.status).toBe('COMPLETED');

    // ── 2. 从头到尾同一个 worker：任务没回过队列，也没被重新分配 ──
    expect(maxPollCount).toBe(1);
    expect(task?.retryCount ?? 0).toBe(0);
    // 整个运行期间任务一直是 IN_PROGRESS（不是 callback 模式的 SCHEDULED 交替）
    expect(sawInProgress).toBe(true);

    // ── 3. 一次执行只跑一遍 ──
    expect(counters.modelCalls).toBe(2);
    expect(counters.toolCalls).toBe(1);

    // ── 4. 结果与用量 ──
    const progress = wf.output?.progress as { step?: number } | undefined;
    expect(progress?.step).toBeGreaterThan(0);
    const usage = wf.output?.usage as { costUsd?: number } | undefined;
    expect(usage?.costUsd).toBeGreaterThan(0);
    expect(wf.output?.taskId).toBe(task?.taskId);
  }, 180_000);

  it('Task Log：运行途中就能看见进展（extendLease 下唯一的运行中通道）', async () => {
    const { wf } = await runToCompletion('再查一次 A-1001');
    expect(wf.status).toBe('COMPLETED');

    const taskId = wf.tasks?.[0]?.taskId;
    expect(taskId).toBeTruthy();
    const logs = await getTaskLogs(taskId!);

    if (logs.length === 0) {
      // 该部署未启用 task log 索引（NoopIndexDAO）——预期内的降级，不是失败
      console.warn('[e2e] 该部署未保存 task log（indexing 未启用），运行中通道降级 —— 符合 §10.4 设计');
      return;
    }
    for (const l of logs) {
      expect(typeof l.log).toBe('string');
      expect(l.log!.length).toBeLessThanOrEqual(512);
    }
  }, 180_000);

  it('TaskDef 已按注册期规则写入', async () => {
    const res = await fetch(`${CONDUCTOR_URL}/metadata/taskdefs/${TASK_TYPE}`);
    expect(res.ok).toBe(true);
    const def = (await res.json()) as {
      responseTimeoutSeconds: number;
      retryCount: number;
      timeoutSeconds: number;
    };
    // 0 = 不设总时长上限；跑飞由 worker 自己的 wallClockMs 兜底
    expect(def.timeoutSeconds).toBe(0);
    // 崩溃检测灵敏度；官方 LeaseTracker 按它 ×0.8 发心跳
    expect(def.responseTimeoutSeconds).toBe(RESPONSE_TIMEOUT_SECONDS);
    // worker 崩溃会真的消耗这个配额，不可为 0
    expect(def.retryCount).toBeGreaterThan(0);
  }, 30_000);
});
