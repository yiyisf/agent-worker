/**
 * 桥接层的行为契约（§6.1、ADR-0022）。
 *
 * extendLease 模式下 execute() 就是「把 agent 跑完」，所以这里断言的是
 * 输入怎么进来、输出怎么出去、失败怎么分类，以及那些**必须在启动时**拒绝的配置错误。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BudgetExceededError,
  type AgentEngine,
  type AgentSpec,
  type BuiltAgent,
  type JsonValue,
} from '@ca/core';
import { silentLogger } from '@ca/core/testkit';
import { compileAgentWorker, type ConductorTaskLike } from './worker.js';
import { deriveTaskDef, diffTaskDefs } from './taskdef.js';
import {
  assertHeartbeatViable,
  assertExtendLeaseSupported,
  heartbeatIntervalMs,
  supportsExtendLease,
} from './lease.js';
import { ExternalInputUnavailableError, resolveInput } from './task-io.js';

function engineOf(run: BuiltAgent['run']): AgentEngine {
  return {
    id: 'test/engine',
    contractVersion: 1,
    capabilities: {
      costVisibility: 'per-call',
      toolInterception: 'all',
      suspend: 'none',
      progress: 'step',
      streaming: false,
      structuredOutput: false,
    },
    builtinTools: [],
    async build() {
      return { run };
    },
  };
}

const spec: AgentSpec = { name: 'demo', engine: 'test/engine' };

function task(over: Partial<ConductorTaskLike> = {}): ConductorTaskLike {
  return {
    taskId: 'task-1',
    workflowInstanceId: 'wf-1',
    referenceTaskName: 'agent_ref',
    retryCount: 0,
    pollCount: 1,
    inputData: { question: 'hi' },
    ...over,
  };
}

function workerOf(run: BuiltAgent['run'], over: Partial<AgentSpec> = {}) {
  return compileAgentWorker({ ...spec, ...over }, { engines: [engineOf(run)], logger: silentLogger });
}

describe('execute()：把 agent 跑完', () => {
  it('恒定开启 leaseExtendEnabled —— 它是「同一 worker」的保证来源', () => {
    expect(workerOf(async () => null).leaseExtendEnabled).toBe(true);
  });

  it('跑完返回 COMPLETED，结果与用量都在 outputData 里', async () => {
    const worker = workerOf(async () => ({ answer: 42 }));
    const res = await worker.execute(task());

    expect(res.status).toBe('COMPLETED');
    expect(res.outputData?.ok).toBe(true);
    expect(res.outputData?.result).toEqual({ answer: 42 });
    expect(res.outputData?.taskId).toBe('task-1');
    // extendLease 模式没有 callbackAfterSeconds —— 任务从不交还
    expect(res.callbackAfterSeconds).toBeUndefined();
  });

  it('长任务不被打断：execute 会一直等到 agent 跑完', async () => {
    const worker = workerOf(async () => {
      await new Promise((r) => setTimeout(r, 120));
      return 'slow but done';
    });
    const t0 = Date.now();
    const res = await worker.execute(task());
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(res.status).toBe('COMPLETED');
  });

  it('可重试失败 → FAILED，交给 TaskDef.retryCount 决定重试', async () => {
    const worker = workerOf(async () => {
      throw new Error('下游超时');
    });
    const res = await worker.execute(task());
    expect(res.status).toBe('FAILED');
    expect(res.reasonForIncompletion).toContain('下游超时');
    expect(res.outputData?.ok).toBe(false);
  });

  it('终局失败 → 抛 TerminalTaskError，由调用方转成 NonRetryableException', async () => {
    const worker = workerOf(async () => {
      throw new BudgetExceededError('cost');
    });
    await expect(worker.execute(task())).rejects.toThrow(/budget exceeded/);
  });

  it('超过 wallClockMs 判终局失败，不会一直挂着', async () => {
    const worker = workerOf(
      (a) =>
        new Promise((_res, rej) => {
          a.ctx.signal.addEventListener('abort', () => rej(a.ctx.signal.reason));
        }),
      { limits: { wallClockMs: 30 } },
    );
    await expect(worker.execute(task())).rejects.toThrow(/wallClockMs/);
  });

  it('工作流已终止时中止运行，不继续烧 token', async () => {
    const isWorkflowCancelled = vi.fn(async () => true);
    const worker = compileAgentWorker(spec, {
      engines: [
        engineOf(
          (a) =>
            new Promise((_res, rej) => {
              a.ctx.signal.addEventListener('abort', () => rej(a.ctx.signal.reason));
            }),
        ),
      ],
      logger: silentLogger,
      isWorkflowCancelled,
      progress: { intervalMs: 1_000 },
    });
    await expect(worker.execute(task())).rejects.toThrow(/工作流已终止/);
    expect(isWorkflowCancelled).toHaveBeenCalledWith('wf-1');
  }, 10_000);
});

describe('运行态输入输出', () => {
  it('inputData 原样就是 agent 的输入，没有保留键', async () => {
    let seen: JsonValue;
    const worker = workerOf(async (a) => {
      seen = a.input;
      return null;
    });
    await worker.execute(task({ inputData: { question: 'hi', orderId: 'A-1001' } }));
    expect(seen!).toEqual({ question: 'hi', orderId: 'A-1001' });
  });

  it('重试时上一次 attempt 的 outputData 由引擎原生带来，交给 agent 做业务判断', async () => {
    let seen: JsonValue | undefined;
    const worker = workerOf(async (a) => {
      seen = a.previousAttempt;
      return null;
    });
    await worker.execute(
      task({ taskId: 'task-2', retryCount: 1, outputData: { ok: false, error: { message: '上次失败了' } } }),
    );
    expect(seen).toEqual({ ok: false, error: { message: '上次失败了' } });
  });

  it('输入被服务端外置且没有 resolver → 明确失败，绝不静默当成空输入', async () => {
    await expect(
      resolveInput({ taskId: 't', inputData: {}, externalInputPayloadStoragePath: 's3://x/y' }),
    ).rejects.toThrow(ExternalInputUnavailableError);
  });

  it('配了 resolver 就把大输入取回来', async () => {
    const got = await resolveInput(
      { taskId: 't', inputData: {}, externalInputPayloadStoragePath: 's3://x/y' },
      async (p) => ({ from: p, doc: 'big' }),
    );
    expect(got).toEqual({ from: 's3://x/y', doc: 'big' });
  });
});

describe('extendLease 版本与取值校验', () => {
  it('extendLease 需要服务端 ≥ 3.10.7', () => {
    expect(supportsExtendLease('3.10.6')).toBe(false);
    expect(supportsExtendLease('3.10.7')).toBe(true);
    expect(supportsExtendLease('v3.21.21')).toBe(true);
    expect(supportsExtendLease('4.0.0')).toBe(true);
    expect(() => assertExtendLeaseSupported('3.10.6')).toThrow(/3\.10\.7/);
    expect(() => assertExtendLeaseSupported('3.21.21')).not.toThrow();
  });

  it('responseTimeoutSeconds 太小时启动即拒绝 —— 官方会静默跳过心跳', () => {
    // 官方 LeaseTracker：intervalMs = timeout × 0.8 × 1000，< 1000ms 直接 return
    expect(() => assertHeartbeatViable(1)).toThrow(/静默跳过|跳过不发/);
    expect(() => assertHeartbeatViable(1.25)).not.toThrow();
    expect(() => compileAgentWorker(
      { ...spec, conductor: { responseTimeoutSeconds: 1 } },
      { engines: [engineOf(async () => null)], logger: silentLogger },
    )).toThrow();
  });

  it('心跳间隔就是 responseTimeoutSeconds × 0.8', () => {
    expect(heartbeatIntervalMs(60)).toBe(48_000);
  });
});

describe('TaskDef 推导（注册期）', () => {
  it('responseTimeout 是崩溃检测灵敏度，默认 60；总时长不设上限', () => {
    const def = deriveTaskDef(spec);
    expect(def.name).toBe('agent_demo');
    // worker 活着就一直心跳，任务想跑多久跑多久
    expect(def.timeoutSeconds).toBe(0);
    // worker 挂了 60 秒后被判 TIMED_OUT 并重新分配
    expect(def.responseTimeoutSeconds).toBe(60);
    // 这个配额现在是真的会被 worker 崩溃消耗的
    expect(def.retryCount).toBeGreaterThan(0);
  });

  it('需要硬 SLA 上限时可显式指定', () => {
    expect(deriveTaskDef({ ...spec, conductor: { taskTimeoutSeconds: 900 } }).timeoutSeconds).toBe(900);
  });

  it('线上 TaskDef 漂移能被检出（responseTimeout 的漂移尤其要紧）', () => {
    const local = [deriveTaskDef(spec)];
    expect(diffTaskDefs(local, [{ ...local[0]!, responseTimeoutSeconds: 1 }])).toEqual([
      { name: 'agent_demo', field: 'responseTimeoutSeconds', local: 60, remote: 1 },
    ]);
    expect(diffTaskDefs(local, [])).toEqual([
      { name: 'agent_demo', field: '*', local: 'defined', remote: 'missing' },
    ]);
  });
});
