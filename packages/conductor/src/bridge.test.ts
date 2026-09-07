/**
 * 桥接层的行为契约：**每次 callback 到底该回什么**（§6.1、ADR-0019/0020/0021）。
 *
 * 这是整个 SDK 最要紧的一组断言 —— 它定义了「同一次执行的多次 callback」
 * 与「不同任务」如何被区分，以及运行结束时任务怎么被推向终态。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AgentRunHost,
  BudgetExceededError,
  MemoryRunRegistry,
  type AgentEngine,
  type BuiltAgent,
  type JsonValue,
} from '@ca/core';
import { silentLogger } from '@ca/core/testkit';
import { compileAgentWorker, type ConductorTaskLike, type UpdateTaskFn } from './worker.js';
import { deriveTaskDef, diffTaskDefs } from './taskdef.js';
import { ExternalInputUnavailableError, resolveInput } from './task-io.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

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

const spec = { name: 'demo', engine: 'test/engine' } as const;

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

describe('callback 协议', () => {
  it('首次 callback：发起后台运行并立刻交还 IN_PROGRESS', async () => {
    const registry = new MemoryRunRegistry();
    let started = false;
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async () => {
        started = true;
        await settle(50);
        return { answer: 42 };
      })],
      registry,
      logger: silentLogger,
    });

    const t0 = Date.now();
    const res = await worker.execute(task());

    // execute 是毫秒级返回的 —— agent 还在后台跑
    expect(Date.now() - t0).toBeLessThan(40);
    expect(res.status).toBe('IN_PROGRESS');
    expect(res.callbackAfterSeconds).toBe(30);
    expect(res.outputData?.status).toBe('running');
    expect(started).toBe(true);
  });

  it('同一 taskId 的后续 callback：报「正在跑」，不重复发起', async () => {
    const registry = new MemoryRunRegistry();
    let runs = 0;
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async () => {
        runs += 1;
        await settle(80);
        return { answer: runs };
      })],
      registry,
      logger: silentLogger,
    });

    await worker.execute(task());
    const second = await worker.execute(task({ pollCount: 2 }));
    const third = await worker.execute(task({ pollCount: 3 }));

    expect(second.status).toBe('IN_PROGRESS');
    expect(third.status).toBe('IN_PROGRESS');
    expect(runs).toBe(1);
  });

  it('不同 taskId 是不同的执行：重试会重新发起', async () => {
    const registry = new MemoryRunRegistry();
    let runs = 0;
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async () => {
        runs += 1;
        await settle(10);
        return runs;
      })],
      registry,
      logger: silentLogger,
    });

    await worker.execute(task({ taskId: 'task-1' }));
    await worker.execute(task({ taskId: 'task-2', retryCount: 1 }));
    await settle(60);
    expect(runs).toBe(2);
  });

  it('运行完成后的 callback：回执 COMPLETED 并带上结果', async () => {
    const registry = new MemoryRunRegistry();
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async () => ({ answer: 42 }))],
      registry,
      logger: silentLogger,
    });

    await worker.execute(task());
    await settle(60);

    const done = await worker.execute(task({ pollCount: 2 }));
    expect(done.status).toBe('COMPLETED');
    expect(done.outputData?.ok).toBe(true);
    expect(done.outputData?.result).toEqual({ answer: 42 });
  });

  it('运行结束时**主动**推向终态，不等下一次 callback', async () => {
    const registry = new MemoryRunRegistry();
    const updateTask = vi.fn<UpdateTaskFn>(async () => {});
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async () => ({ answer: 7 }))],
      registry,
      logger: silentLogger,
      updateTask,
    });

    await worker.execute(task());
    await settle(60);

    expect(updateTask).toHaveBeenCalledTimes(1);
    const call = updateTask.mock.calls[0]![0]!;
    expect(call.taskId).toBe('task-1');
    expect(call.workflowInstanceId).toBe('wf-1');
    expect(call.status).toBe('COMPLETED');
    expect((call.outputData as { result?: unknown }).result).toEqual({ answer: 7 });
  });

  it('可重试失败 → FAILED，交给 TaskDef.retryCount 决定重试', async () => {
    const registry = new MemoryRunRegistry();
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async () => {
        throw new Error('下游超时');
      })],
      registry,
      logger: silentLogger,
    });

    await worker.execute(task());
    await settle(40);
    const res = await worker.execute(task({ pollCount: 2 }));

    expect(res.status).toBe('FAILED');
    expect(res.reasonForIncompletion).toContain('下游超时');
    expect(res.outputData?.ok).toBe(false);
  });

  it('终局失败 → 抛 TerminalTaskError，由调用方转成 NonRetryableException', async () => {
    const registry = new MemoryRunRegistry();
    const worker = compileAgentWorker(spec, {
      // 预算耗尽是终局的：再跑一次还是会超
      engines: [engineOf(async () => {
        throw new BudgetExceededError('cost');
      })],
      registry,
      logger: silentLogger,
    });

    await worker.execute(task());
    await settle(40);
    await expect(worker.execute(task({ pollCount: 2 }))).rejects.toThrow(/budget exceeded/);
  });

  it('宿主失联后由另一个 worker 接管重跑，不消耗 Conductor 重试配额', async () => {
    // 共享注册表 + 两个独立宿主 = 集群部署下「callback 落到别的 worker」的真实形态
    const registry = new MemoryRunRegistry();
    let runs = 0;
    const engines = [engineOf(async () => {
      runs += 1;
      await settle(200);
      return runs;
    })];
    const conductor = { orphanAfterMs: 0 };
    const workerA = compileAgentWorker(
      { ...spec, conductor },
      { engines, registry, logger: silentLogger, workerId: 'A',
        host: new AgentRunHost({ registry, workerId: 'A', logger: silentLogger }) },
    );
    const workerB = compileAgentWorker(
      { ...spec, conductor },
      { engines, registry, logger: silentLogger, workerId: 'B',
        host: new AgentRunHost({ registry, workerId: 'B', logger: silentLogger }) },
    );

    await workerA.execute(task());
    await settle(5);
    // orphanAfterMs=0：A 的心跳还没来得及刷新就被判失联，B 接管
    const second = await workerB.execute(task({ pollCount: 2 }));

    expect(second.status).toBe('IN_PROGRESS');
    expect(runs).toBe(2);
    // 关键：taskId 没变，retryCount 也没变 —— 这不是 Conductor 的重试
    expect(second.outputData?.runId).toBe('task-1');
    expect(second.outputData?.attempts).toBe(2);
  });

  it('onOrphan=fail：失联即判失败，不接管', async () => {
    const registry = new MemoryRunRegistry();
    let runs = 0;
    const worker = compileAgentWorker(
      { ...spec, conductor: { orphanAfterMs: 0, onOrphan: 'fail' } },
      {
        engines: [engineOf(async () => {
          runs += 1;
          await settle(100);
          return runs;
        })],
        registry,
        logger: silentLogger,
      },
    );

    await worker.execute(task());
    await settle(5);
    const second = await worker.execute(task({ pollCount: 2 }));

    expect(second.status).toBe('FAILED');
    expect(runs).toBe(1);
  });

  it('缺少 taskId 直接判终局失败 —— 没有它就无法标识本次运行', async () => {
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async () => null)],
      registry: new MemoryRunRegistry(),
      logger: silentLogger,
    });
    const { taskId: _drop, ...noId } = task();
    await expect(worker.execute(noId)).rejects.toThrow(/taskId/);
  });
});

describe('运行态输入输出', () => {
  it('inputData 原样就是 agent 的输入，没有保留键', async () => {
    const registry = new MemoryRunRegistry();
    let seen: JsonValue;
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async (a) => {
        seen = a.input;
        return null;
      })],
      registry,
      logger: silentLogger,
    });
    await worker.execute(task({ inputData: { question: 'hi', orderId: 'A-1001' } }));
    await settle(30);
    expect(seen!).toEqual({ question: 'hi', orderId: 'A-1001' });
  });

  it('重试时上一次 attempt 的 outputData 由引擎原生带来，交给 agent 做业务判断', async () => {
    const registry = new MemoryRunRegistry();
    let seen: JsonValue | undefined;
    const worker = compileAgentWorker(spec, {
      engines: [engineOf(async (a) => {
        seen = a.previousAttempt;
        return null;
      })],
      registry,
      logger: silentLogger,
    });
    await worker.execute(
      task({ taskId: 'task-2', retryCount: 1, outputData: { ok: false, error: { message: '上次失败了' } } }),
    );
    await settle(30);
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

describe('TaskDef 推导（注册期）', () => {
  it('长任务不设总时长上限，responseTimeout 保持服务端默认', () => {
    const def = deriveTaskDef(spec);
    expect(def.name).toBe('agent_demo');
    // 0 = checkTaskTimeout 直接 return，任务不会因为跑太久被判超时
    expect(def.timeoutSeconds).toBe(0);
    // 刻意不调小：调小会抢在队列 unack 前把任务判 TIMED_OUT 并消耗一次 retryCount
    expect(def.responseTimeoutSeconds).toBe(3600);
    expect(def.retryCount).toBeGreaterThan(0);
  });

  it('需要硬 SLA 上限时可显式指定', () => {
    const def = deriveTaskDef({ ...spec, conductor: { taskTimeoutSeconds: 900 } as never });
    expect(def.timeoutSeconds).toBe(900);
  });

  it('线上 TaskDef 漂移能被检出（运维视角，不影响运行）', () => {
    const local = [deriveTaskDef(spec)];
    expect(diffTaskDefs(local, [{ ...local[0]!, retryCount: 0 }])).toEqual([
      { name: 'agent_demo', field: 'retryCount', local: 3, remote: 0 },
    ]);
    expect(diffTaskDefs(local, [])).toEqual([
      { name: 'agent_demo', field: '*', local: 'defined', remote: 'missing' },
    ]);
  });
});
