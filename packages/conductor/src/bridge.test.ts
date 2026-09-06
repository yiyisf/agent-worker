import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { MemoryStateStore } from '@ca/core';
import type { AgentEngine, AgentSpec, EngineCapabilities, JsonValue } from '@ca/core';
import { RedisStateStore, type RedisLike } from '@ca/memory';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  MIN_RESPONSE_TIMEOUT_SECONDS,
  TerminalTaskError,
  assertExtendLeaseSupported,
  checkHandbackBudget,
  compileAgentWorker,
  createCancellationWatcher,
  deriveTaskDef,
  diffTaskDefs,
  runKeyOf,
  supportsExtendLease,
  toTaskResult,
  type ConductorTaskLike,
} from './index.js';

const REDIS_URL = process.env.CA_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';
const clients: Redis[] = [];

const newClient = (): Redis => {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  clients.push(c);
  return c;
};

/**
 * 需要 Redis 的用例在没有 Redis 时**跳过而不是失败** ——
 * 纯逻辑部分（TaskDef 推导、结果映射、取消检测）任何机器上都该能跑。
 * 本地起一个：redis-server --port 6380 --daemonize yes --save '' --appendonly no
 */
let redisReachable = false;
try {
  const probe = newClient();
  await probe.connect();
  await probe.ping();
  redisReachable = true;
} catch {
  redisReachable = false;
}

async function redisStore(): Promise<RedisStateStore> {
  const c = newClient();
  await c.connect();
  return new RedisStateStore({ client: c as unknown as RedisLike, prefix: `ca-bridge-${Date.now()}` });
}

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.quit()));
});

const caps: EngineCapabilities = {
  costVisibility: 'per-call',
  toolInterception: 'all',
  state: 'messages',
  suspend: 'native-approval',
  sliceControl: 'native',
  granularity: 'step',
  progress: 'step',
  streaming: false,
  structuredOutput: false,
};

/** 一个最小引擎：跑 n 次模型调用，每片跑一次 */
function fakeEngine(totalCalls: number, counter: { n: number }): AgentEngine<never> {
  return {
    id: 'fake/engine',
    contractVersion: 1,
    capabilities: caps,
    builtinTools: [],
    async build() {
      return {
        async run({ gateways, state }) {
          const done = ((state as { done?: number } | undefined)?.done ?? 0) as number;
          await gateways.model.guard({ step: done }, async () => {
            counter.n += 1;
            return { result: { step: done }, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } };
          });
          const next = done + 1;
          if (next >= totalCalls) return { kind: 'done', output: { steps: next } as JsonValue };
          return { kind: 'continue', state: { done: next } as never };
        },
      };
    },
  };
}

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  name: 'demo',
  engine: 'fake/engine',
  ...over,
});

const task = (over: Partial<ConductorTaskLike> = {}): ConductorTaskLike => ({
  taskId: 't1',
  workflowInstanceId: 'wf-1',
  workflowType: 'demo_wf',
  referenceTaskName: 'agent_ref',
  retryCount: 0,
  startTime: Date.now(),
  inputData: { input: '干活' },
  ...over,
});

describe('TaskDef 推导（§6.6）', () => {
  it('callback 策略下 responseTimeoutSeconds 有 30s 下限', () => {
    // sliceMs=1s 推出来是 3s，会被夹到 30s：该值同时决定 decider 重扫频率，调小会加重服务端负载
    const d = deriveTaskDef(spec({ limits: { sliceMs: 1_000, wallClockMs: 60_000 } }));
    expect(d.responseTimeoutSeconds).toBe(MIN_RESPONSE_TIMEOUT_SECONDS);
  });

  it('sliceMs 较大时按 ×3 推导', () => {
    const d = deriveTaskDef(spec({ limits: { sliceMs: 60_000 } }));
    expect(d.responseTimeoutSeconds).toBe(180);
  });

  it('timeoutSeconds 覆盖 wallClockMs（含所有分片与等待）', () => {
    const d = deriveTaskDef(spec({ limits: { wallClockMs: 600_000 } }));
    expect(d.timeoutSeconds).toBe(720);
  });

  it('retryCount 不可为 0 —— 租约超时会消耗一次重试配额', () => {
    expect(deriveTaskDef(spec()).retryCount).toBeGreaterThan(0);
  });

  it('lease-extend 下 responseTimeoutSeconds 故意设短（崩溃检测灵敏度）', () => {
    const d = deriveTaskDef(spec({ conductor: { leaseStrategy: 'lease-extend' }, limits: { wallClockMs: 1_800_000 } }));
    expect(d.responseTimeoutSeconds).toBe(60);
    expect(d.timeoutSeconds).toBe(2160);
  });

  it('diffTaskDefs 报出线上漂移', () => {
    // 默认 spec 没设 limits：sliceMs 取默认 60s，推出 180s（不触发 30s 下限）
    const local = [deriveTaskDef(spec())];
    expect(local[0]!.responseTimeoutSeconds).toBe(180);
    const drift = diffTaskDefs(local, [{ name: local[0]!.name, responseTimeoutSeconds: 5 }]);
    expect(drift).toEqual([
      { name: local[0]!.name, field: 'responseTimeoutSeconds', local: 180, remote: 5 },
    ]);
  });
});

describe('extendLease 版本探测（ADR-0009）', () => {
  it('3.10.6 不支持，3.10.7 起支持', () => {
    expect(supportsExtendLease('3.10.6')).toBe(false);
    expect(supportsExtendLease('3.10.7')).toBe(true);
    expect(supportsExtendLease('3.21.21')).toBe(true);
    expect(supportsExtendLease('v3.9.0')).toBe(false);
  });

  it('版本不足时拒绝启动并提示改用 callback', () => {
    expect(() => assertExtendLeaseSupported('3.10.6')).toThrow(/callback/);
    expect(() => assertExtendLeaseSupported('3.21.21')).not.toThrow();
  });
});

describe('交还预算（§2.2：真正的约束是 Σ执行+等待 < timeoutSeconds）', () => {
  const start = 1_000_000;

  it('剩余时间充足时原样交还', () => {
    const r = checkHandbackBudget({
      requestedCallbackAfterSeconds: 30,
      taskStartTimeMs: start,
      timeoutSeconds: 600,
      now: start + 10_000,
    });
    expect(r).toEqual({ seconds: 30, clamped: false, willExceedTotalTimeout: false });
  });

  it('会撞上总超时时夹住并标记', () => {
    const r = checkHandbackBudget({
      requestedCallbackAfterSeconds: 3600,
      taskStartTimeMs: start,
      timeoutSeconds: 600,
      now: start + 10_000,
    });
    expect(r.clamped).toBe(true);
    expect(r.willExceedTotalTimeout).toBe(true);
    expect(r.seconds).toBeLessThan(600);
    expect(r.seconds).toBeGreaterThan(0);
  });

  it('总时间已经耗尽时交还 0', () => {
    const r = checkHandbackBudget({
      requestedCallbackAfterSeconds: 30,
      taskStartTimeMs: start,
      timeoutSeconds: 60,
      now: start + 120_000,
    });
    expect(r.seconds).toBe(0);
    expect(r.willExceedTotalTimeout).toBe(true);
  });
});

describe('结果映射（§6.2）', () => {
  const budget = { inputTokens: 10, outputTokens: 5, costUsd: 0.01, toolCalls: 1, modelCalls: 2 };

  it('done → COMPLETED', async () => {
    const r = await toTaskResult({
      outcome: { kind: 'done', output: { answer: 42 }, budget, sliceIndex: 0 },
    });
    expect(r.status).toBe('COMPLETED');
    expect(r.outputData?.ok).toBe(true);
    expect(r.outputData?.result).toEqual({ answer: 42 });
    expect(r.outputData?.slices).toBe(1);
  });

  it('continue → IN_PROGRESS 并带 callbackAfterSeconds', async () => {
    const r = await toTaskResult({
      outcome: { kind: 'continue', budget, sliceIndex: 1 },
      callbackAfterSeconds: 3,
    });
    expect(r.status).toBe('IN_PROGRESS');
    expect(r.callbackAfterSeconds).toBe(3);
    expect(r.outputData?.state).toBe('continue');
  });

  it('suspended → IN_PROGRESS 并把 awaiting 与 resumeToken 暴露给工作流', async () => {
    const r = await toTaskResult({
      outcome: {
        kind: 'suspended',
        awaiting: { kind: 'approval', ref: 'appr-1', toolName: 'refund' },
        resumeToken: 'unsigned.abc',
        budget,
        sliceIndex: 0,
      },
      callbackAfterSeconds: 60,
    });
    expect(r.status).toBe('IN_PROGRESS');
    expect((r.outputData?.awaiting as { ref: string }).ref).toBe('appr-1');
    expect(r.outputData?.resumeToken).toBe('unsigned.abc');
  });

  it('瞬时错误 → FAILED（交给 TaskDef 重试）', async () => {
    const r = await toTaskResult({
      outcome: {
        kind: 'failed',
        error: { name: 'CaError', message: '429 rate limited', retryable: true },
        budget,
        sliceIndex: 0,
      },
    });
    expect(r.status).toBe('FAILED');
    expect(r.reasonForIncompletion).toContain('429');
  });

  it('终局错误 → 抛 TerminalTaskError（调用方转成 NonRetryableException）', async () => {
    await expect(
      toTaskResult({
        outcome: {
          kind: 'failed',
          error: { name: 'AmbiguousReplayError', message: '副作用未知', retryable: false },
          budget,
          sliceIndex: 0,
        },
      }),
    ).rejects.toBeInstanceOf(TerminalTaskError);
  });

  it('超预算的输出外置到 BlobStore，outputData 只留 ref', async () => {
    const stored: string[] = [];
    const blobStore = {
      async put(_k: string, body: Uint8Array | string) {
        stored.push(String(body));
        return { ref: 'blob://x', bytes: String(body).length, sha256: 'deadbeef' };
      },
      async get() {
        return new Uint8Array();
      },
    };
    const big = { blob: 'x'.repeat(DEFAULT_MAX_OUTPUT_BYTES + 10) };
    const r = await toTaskResult(
      { outcome: { kind: 'done', output: big as JsonValue, budget, sliceIndex: 0 } },
      { blobStore, payloadStrategy: 'externalize' },
    );
    expect(r.outputData?.transcriptRef).toBe('blob://x');
    expect((r.outputData?.result as { externalized: boolean }).externalized).toBe(true);
    expect(stored).toHaveLength(1);
  });
});

describe('Worker 编译（不需要 Redis）', () => {
  it('runKey 由 resumePolicy 决定 epoch（§5.2）', () => {
    const t = task({ retryCount: 3 });
    expect(runKeyOf(spec(), t)).toBe('wf-1:agent_ref:0');
    expect(runKeyOf(spec({ conductor: { resumePolicy: 'fresh-per-retry' } }), t)).toBe('wf-1:agent_ref:3');
  });

  it('callback 策略 + 内存 StateStore → 启动即拒绝', () => {
    expect(() =>
      compileAgentWorker(spec(), {
        engines: [fakeEngine(1, { n: 0 })],
        stateStore: new MemoryStateStore(),
      }),
    ).toThrow(/持久化 StateStore/);
  });
});

describe.skipIf(!redisReachable)('Worker 执行（需要 Redis）', () => {

  it('引擎未注册 → 启动即拒绝', async () => {
    const store = await redisStore();
    expect(() =>
      compileAgentWorker(spec({ engine: 'nope' }), {
        engines: [fakeEngine(1, { n: 0 })],
        stateStore: store,
      }),
    ).toThrow(/未注册/);
  });

  it('单片跑完 → COMPLETED', async () => {
    const counter = { n: 0 };
    const worker = compileAgentWorker(spec(), {
      engines: [fakeEngine(1, counter)],
      stateStore: await redisStore(),
    });
    const r = await worker.execute(task());
    expect(r.status).toBe('COMPLETED');
    expect(counter.n).toBe(1);
    expect(worker.taskDefName).toBe('agent_demo');
  });

  it('多片：第一片交还、第二片完成，且不重复调用模型', async () => {
    const counter = { n: 0 };
    const store = await redisStore();
    const worker = compileAgentWorker(spec(), { engines: [fakeEngine(2, counter)], stateStore: store });
    const t = task();

    const first = await worker.execute(t);
    expect(first.status).toBe('IN_PROGRESS');
    expect(first.callbackAfterSeconds).toBeGreaterThanOrEqual(0);
    expect(counter.n).toBe(1);

    const second = await worker.execute(t);
    expect(second.status).toBe('COMPLETED');
    // 第二片只新增了一次模型调用：第一片那次被 journal 短路了
    expect(counter.n).toBe(2);
    expect(second.outputData?.slices).toBe(2);
  });

  it('租约被别人持有时交还任务，不并发跑', async () => {
    const counter = { n: 0 };
    const store = await redisStore();
    const worker = compileAgentWorker(spec(), { engines: [fakeEngine(1, counter)], stateStore: store });
    const t = task();
    // 别的 worker 先占住
    await store.acquire(runKeyOf(spec(), t), 'someone-else', 60_000);

    const r = await worker.execute(t);
    expect(r.status).toBe('IN_PROGRESS');
    expect(r.outputData?.state).toBe('contended');
    expect(counter.n).toBe(0);
  });

  it('工作流已终止时不再烧 token（§6.4）', async () => {
    const counter = { n: 0 };
    const worker = compileAgentWorker(spec(), {
      engines: [fakeEngine(1, counter)],
      stateStore: await redisStore(),
      isWorkflowCancelled: async () => true,
    });
    await expect(worker.execute(task())).rejects.toBeInstanceOf(TerminalTaskError);
    expect(counter.n).toBe(0);
  });
});

describe('取消检测（§6.4）', () => {
  it('同工作流的并发查询合并成一次请求', async () => {
    let calls = 0;
    const { isWorkflowCancelled } = createCancellationWatcher({
      getStatus: async () => {
        calls += 1;
        return 'RUNNING';
      },
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => isWorkflowCancelled('wf-1')));
    expect(results.every((r) => r === false)).toBe(true);
    expect(calls).toBe(1);
  });

  it('命中终止状态才判取消', async () => {
    const { isWorkflowCancelled } = createCancellationWatcher({ getStatus: async () => 'TERMINATED' });
    expect(await isWorkflowCancelled('wf-9')).toBe(true);
  });

  it('查询失败不判取消 —— 网络抖动不该让正常运行的 Agent 被判死', async () => {
    const { isWorkflowCancelled } = createCancellationWatcher({
      getStatus: async () => {
        throw new Error('network');
      },
    });
    expect(await isWorkflowCancelled('wf-2')).toBe(false);
  });
});

describe.skipIf(!redisReachable)('进展反馈接进 worker（需要 Redis，§10.4 / ADR-0018）', () => {
  it('权威通道：outputData.progress 随分片交还一起写出，零额外请求', async () => {
    const store = await redisStore();
    const worker = compileAgentWorker(spec(), {
      engines: [fakeEngine(2, { n: 0 })],
      stateStore: store,
      progress: { intervalMs: 0 },
    });
    const t = task();

    const first = await worker.execute(t);
    expect(first.status).toBe('IN_PROGRESS');
    const p = first.outputData?.progress as { step: number; usage: { tokens: number } };
    expect(p.step).toBeGreaterThan(0);
    expect(p.usage.tokens).toBe(15);

    const second = await worker.execute(t);
    expect((second.outputData?.progress as { step: number }).step).toBeGreaterThanOrEqual(p.step);
  });

  it('尽力而为通道：进展写进 task log，且单次不超过 10 条', async () => {
    const batches: string[][] = [];
    const worker = compileAgentWorker(spec(), {
      engines: [fakeEngine(1, { n: 0 })],
      stateStore: await redisStore(),
      progress: { intervalMs: 0 },
      taskLogSink: () => ({ addLogs: (lines) => void batches.push(lines) }),
    });
    await worker.execute(task());
    expect(batches.length).toBeGreaterThan(0);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(10);
    // 日志是给人看的一行文本，不该是 payload
    expect(batches.flat().every((l) => typeof l === 'string' && l.length <= 512)).toBe(true);
  });

  it('跨 taskId 重试时补一条续接摘要，把断档接上', async () => {
    const store = await redisStore();
    const lines: string[] = [];
    const worker = compileAgentWorker(spec(), {
      engines: [fakeEngine(3, { n: 0 })],
      stateStore: store,
      progress: { intervalMs: 0 },
      taskLogSink: () => ({ addLogs: (batch) => void lines.push(...batch) }),
    });

    await worker.execute(task());
    lines.length = 0;
    // responseTimeout → TIMED_OUT → 重试：新 taskId、retryCount +1，task log 从头开始
    await worker.execute(task({ taskId: 't2', retryCount: 1 }));
    expect(lines.some((l) => l.includes('从第') && l.includes('步恢复'))).toBe(true);
  });

  it('没有 taskLogSink 时只走权威通道，不报错', async () => {
    const worker = compileAgentWorker(spec(), {
      engines: [fakeEngine(1, { n: 0 })],
      stateStore: await redisStore(),
    });
    const r = await worker.execute(task());
    expect(r.status).toBe('COMPLETED');
    expect(r.outputData?.progress).toBeDefined();
  });
});
