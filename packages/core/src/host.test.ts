/**
 * 后台运行宿主的行为契约（ADR-0019/0021）。
 *
 * 最关键的一条是最后一个用例：运行结束时**主动**把结果推出去，
 * 不必等下一次 callback —— 那是异步化模型能成立的前提。
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentRunHost } from './host.js';
import { MemoryRunRegistry } from './registry.js';
import type { RunOutcomeRecord } from './registry.js';
import type { BuiltAgent } from './engine.js';
import { silentLogger, spec } from './testkit.js';

const settle = () => new Promise((r) => setTimeout(r, 20));

function agentOf(run: BuiltAgent['run']): BuiltAgent {
  return { run };
}

describe('AgentRunHost', () => {
  it('start 立即返回，运行在后台完成后写进注册表', async () => {
    const registry = new MemoryRunRegistry();
    const host = new AgentRunHost({ registry, workerId: 'w1', logger: silentLogger });
    await registry.tryStart('t1', 'w1', { orphanAfterMs: 10_000 });

    let released = false;
    host.start({
      runId: 't1',
      spec: spec(),
      agent: agentOf(async () => {
        await new Promise((r) => setTimeout(r, 10));
        released = true;
        return { answer: 'ok' };
      }),
      input: null,
      attempt: 0,
      takeover: false,
    });

    // start 是同步返回的：此刻运行还没跑完
    expect(released).toBe(false);
    expect(host.size).toBe(1);

    await host.drain();
    const rec = await registry.get('t1');
    expect(rec?.status).toBe('done');
    expect(rec?.result).toEqual({ answer: 'ok' });
  });

  it('运行抛错 → 注册表记 failed，并保留 retryable 供桥接层映射状态', async () => {
    const registry = new MemoryRunRegistry();
    const host = new AgentRunHost({ registry, workerId: 'w1', logger: silentLogger });
    await registry.tryStart('t1', 'w1', { orphanAfterMs: 10_000 });

    host.start({
      runId: 't1',
      spec: spec(),
      agent: agentOf(async () => {
        throw new Error('boom');
      }),
      input: null,
      attempt: 0,
      takeover: false,
    });
    await host.drain();

    const rec = await registry.get('t1');
    expect(rec?.status).toBe('failed');
    expect(rec?.error?.message).toBe('boom');
    expect(rec?.error?.retryable).toBe(true);
  });

  it('运行结束立刻回调 onSettled —— 桥接层据此直接回执，不等下一次 callback', async () => {
    const registry = new MemoryRunRegistry();
    const host = new AgentRunHost({ registry, workerId: 'w1', logger: silentLogger });
    await registry.tryStart('t1', 'w1', { orphanAfterMs: 10_000 });

    const onSettled = vi.fn<(o: RunOutcomeRecord) => void>();
    host.start({
      runId: 't1',
      spec: spec(),
      agent: agentOf(async () => 'done'),
      input: null,
      attempt: 0,
      takeover: false,
      onSettled,
    });
    await host.drain();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]![0]!.status).toBe('done');
    expect(onSettled.mock.calls[0]![0]!.result).toBe('done');
  });

  it('所有权已被接管时结果被丢弃，不覆盖新 owner', async () => {
    let clock = 0;
    const registry = new MemoryRunRegistry(3_600_000, () => clock);
    const host = new AgentRunHost({ registry, workerId: 'w1', logger: silentLogger });
    await registry.tryStart('t1', 'w1', { orphanAfterMs: 100 });

    const onSettled = vi.fn();
    host.start({
      runId: 't1',
      spec: spec(),
      agent: agentOf(async () => {
        await new Promise((r) => setTimeout(r, 30));
        return 'stale';
      }),
      input: null,
      attempt: 0,
      takeover: false,
      onSettled,
    });

    // 运行还在跑的时候被另一个 worker 接管
    clock += 200;
    await registry.tryStart('t1', 'w2', { orphanAfterMs: 100 });

    await host.drain();
    await settle();

    expect(onSettled).not.toHaveBeenCalled();
    const rec = await registry.get('t1');
    expect(rec?.status).toBe('running');
    expect(rec?.owner).toBe('w2');
  });

  it('同一 runId 重复 start 不会跑两遍', async () => {
    const registry = new MemoryRunRegistry();
    const host = new AgentRunHost({ registry, workerId: 'w1', logger: silentLogger });
    await registry.tryStart('t1', 'w1', { orphanAfterMs: 10_000 });

    let runs = 0;
    const args = {
      runId: 't1',
      spec: spec(),
      agent: agentOf(async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 10));
        return runs;
      }),
      input: null,
      attempt: 0,
      takeover: false,
    };
    host.start(args);
    host.start(args);
    await host.drain();

    expect(runs).toBe(1);
  });

  it('超过 wallClockMs 判失败且不可重试', async () => {
    const registry = new MemoryRunRegistry();
    const host = new AgentRunHost({ registry, workerId: 'w1', logger: silentLogger });
    await registry.tryStart('t1', 'w1', { orphanAfterMs: 10_000 });

    host.start({
      runId: 't1',
      spec: spec({ limits: { wallClockMs: 20 } }),
      agent: agentOf(
        (a) =>
          new Promise((_resolve, reject) => {
            a.ctx.signal.addEventListener('abort', () => reject(a.ctx.signal.reason));
          }),
      ),
      input: null,
      attempt: 0,
      takeover: false,
    });
    await host.drain();

    const rec = await registry.get('t1');
    expect(rec?.status).toBe('failed');
    expect(rec?.error?.name).toBe('RunTimeoutError');
    expect(rec?.error?.retryable).toBe(false);
  });
});
