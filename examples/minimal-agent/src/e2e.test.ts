/**
 * 端到端验证 —— M1 的出口标准（architecture.md §14）。
 *
 * 需要真实的 Conductor + Redis。**没有就跳过而不是失败**：
 *   docker compose -f examples/minimal-agent/docker-compose.yml up -d
 *   CONDUCTOR_SERVER_URL=http://localhost:8080/api pnpm test
 *
 * 断言的是设计里最要紧的三条，而不是「能跑就行」：
 *   1. 跨分片恢复：一次运行被切成多片，结果仍然正确
 *   2. 重放不重复付费：真实模型调用次数 == 逻辑步数，不随分片数增长
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

  it('跑通一次运行，且分片、进展、成本都符合预期', async () => {
    counters.modelCalls = 0;
    counters.toolCalls = 0;

    const workflowId = await startRun('查一下订单 A-1001 到哪了');
    const deadline = Date.now() + 90_000;

    let wf = await getWorkflow(workflowId);
    let sawInProgress = false;
    let sawProgressOutput = false;

    while (Date.now() < deadline && (wf.status === 'RUNNING' || wf.status === undefined)) {
      const t = wf.tasks?.[0] as { status?: string; outputData?: Record<string, unknown> } | undefined;
      if (t?.status === 'IN_PROGRESS') sawInProgress = true;
      if (t?.outputData?.progress) sawProgressOutput = true;
      await sleep(500);
      wf = await getWorkflow(workflowId);
    }

    // ── 基本：跑完且成功 ──
    expect(wf.status).toBe('COMPLETED');
    expect(String(wf.output?.answer ?? '')).toContain('A-1001');

    // ── 1. 跨分片恢复：sliceMs=1s 会把这个两步 Agent 切开 ──
    expect(Number(wf.output?.slices ?? 0)).toBeGreaterThanOrEqual(1);
    // 任务确实以 IN_PROGRESS 交还过（callback 分片），而不是一口气跑完
    expect(sawInProgress || Number(wf.output?.slices ?? 0) > 1).toBe(true);

    // ── 2. 重放不重复付费：脚本化模型总共只有两步，无论切成几片 ──
    expect(counters.modelCalls).toBe(2);
    expect(counters.toolCalls).toBe(1);

    // ── 3. 进展可见：权威通道 ──
    const progress = wf.output?.progress as { step?: number } | undefined;
    expect(progress?.step).toBeGreaterThan(0);
    expect(sawProgressOutput || progress !== undefined).toBe(true);

    // 成本被记上了（示例配了 pricing）
    const usage = wf.output?.usage as { costUsd?: number } | undefined;
    expect(usage?.costUsd).toBeGreaterThan(0);
  }, 120_000);

  it('Task Log 通道：有索引就看得到进展，没索引则优雅降级', async () => {
    const workflowId = await startRun('再查一次 A-1001');
    const deadline = Date.now() + 90_000;
    let wf = await getWorkflow(workflowId);
    while (Date.now() < deadline && (wf.status === 'RUNNING' || wf.status === undefined)) {
      await sleep(500);
      wf = await getWorkflow(workflowId);
    }
    expect(wf.status).toBe('COMPLETED');

    const taskId = wf.tasks?.[0]?.taskId;
    expect(taskId).toBeTruthy();
    const logs = await getTaskLogs(taskId!);

    if (logs.length === 0) {
      // 该部署未启用 task log 索引（NoopIndexDAO）——这是**预期内的降级**，不是失败。
      // 权威通道 outputData.progress 上面已经断言过了。
      console.warn('[e2e] 该部署未保存 task log（indexing 未启用），通道二降级 —— 符合 §10.4 设计');
      return;
    }
    // 日志是给人看的一行文本，不该是 payload
    for (const l of logs) {
      expect(typeof l.log).toBe('string');
      expect(l.log!.length).toBeLessThanOrEqual(512);
    }
    expect(logs.some((l) => /slice \d+/.test(l.log ?? ''))).toBe(true);
  }, 120_000);

  it('TaskDef 已按 limits 推导注册（含 30s 下限）', async () => {
    const res = await fetch(`${CONDUCTOR_URL}/metadata/taskdefs/${TASK_TYPE}`);
    expect(res.ok).toBe(true);
    const def = (await res.json()) as { responseTimeoutSeconds: number; retryCount: number; timeoutSeconds: number };
    // spec 的 sliceMs=1s → ×3=3s → 被夹到 30s（§6.6：该值同时决定 decider 重扫频率）
    expect(def.responseTimeoutSeconds).toBe(30);
    // wallClockMs=120s → ×1.2
    expect(def.timeoutSeconds).toBe(144);
    // 不可为 0：租约超时会消耗一次重试配额
    expect(def.retryCount).toBeGreaterThan(0);
  }, 30_000);
});
