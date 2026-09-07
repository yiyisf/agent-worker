/**
 * 运行注册表的行为契约（ADR-0019/0020/0021）。
 *
 * 这套断言是「同一次执行的多次 callback」与「不同任务」如何被区分的**唯一**依据，
 * 也是并发 poll 下不会跑两遍的唯一保证。
 */
import { describe, expect, it } from 'vitest';
import { MemoryRunRegistry } from './registry.js';

const OPTS = { orphanAfterMs: 1_000 };

describe('MemoryRunRegistry', () => {
  it('首次 tryStart 取得所有权；同一 runId 的后续 callback 一律看到「正在跑」', async () => {
    const r = new MemoryRunRegistry();
    const first = await r.tryStart('task-1', 'w1', OPTS);
    expect(first.ok).toBe(true);
    expect(first.ok && first.takeover).toBe(false);

    for (const worker of ['w1', 'w2', 'w3']) {
      const again = await r.tryStart('task-1', worker, OPTS);
      expect(again.ok).toBe(false);
      expect(!again.ok && again.reason).toBe('running');
    }
  });

  it('并发 tryStart 只有一个能拿到所有权', async () => {
    const r = new MemoryRunRegistry();
    const results = await Promise.all(
      ['a', 'b', 'c', 'd'].map((w) => r.tryStart('task-1', w, OPTS)),
    );
    expect(results.filter((x) => x.ok)).toHaveLength(1);
  });

  it('不同 taskId 互不影响 —— 重试与新工作流实例天然被区分开', async () => {
    const r = new MemoryRunRegistry();
    expect((await r.tryStart('task-1', 'w1', OPTS)).ok).toBe(true);
    expect((await r.tryStart('task-2', 'w1', OPTS)).ok).toBe(true);
  });

  it('心跳过期后可被接管，attempts 递增', async () => {
    let clock = 1_000;
    const r = new MemoryRunRegistry(3_600_000, () => clock);
    await r.tryStart('t', 'w1', OPTS);

    clock += 500;
    expect((await r.tryStart('t', 'w2', OPTS)).ok).toBe(false); // 还新鲜

    clock += 1_000; // 超过 orphanAfterMs
    const taken = await r.tryStart('t', 'w2', OPTS);
    expect(taken.ok).toBe(true);
    expect(taken.ok && taken.takeover).toBe(true);
    expect(taken.ok && taken.record.attempts).toBe(2);
  });

  it('心跳能刷新存活；被接管后旧 owner 的心跳被拒', async () => {
    let clock = 1_000;
    const r = new MemoryRunRegistry(3_600_000, () => clock);
    await r.tryStart('t', 'w1', OPTS);

    clock += 900;
    expect(await r.heartbeat('t', 'w1')).toBe(true);
    clock += 900;
    // 心跳刷新过，所以仍未过期
    expect((await r.tryStart('t', 'w2', OPTS)).ok).toBe(false);

    clock += 1_100;
    await r.tryStart('t', 'w2', OPTS);
    expect(await r.heartbeat('t', 'w1')).toBe(false);
    expect(await r.heartbeat('t', 'w2')).toBe(true);
  });

  it('接管次数用尽后判失败，不再无限重启', async () => {
    let clock = 0;
    const r = new MemoryRunRegistry(3_600_000, () => clock);
    const opts = { orphanAfterMs: 100, maxAttempts: 2 };

    await r.tryStart('t', 'w1', opts);
    clock += 200;
    expect((await r.tryStart('t', 'w2', opts)).ok).toBe(true); // attempts=2
    clock += 200;
    const third = await r.tryStart('t', 'w3', opts);
    expect(third.ok).toBe(false);
    expect(!third.ok && third.reason).toBe('settled');
    expect(!third.ok && third.record.status).toBe('failed');
  });

  it('onOrphan=fail 语义：maxAttempts=1 时失联即判失败', async () => {
    let clock = 0;
    const r = new MemoryRunRegistry(3_600_000, () => clock);
    const opts = { orphanAfterMs: 100, maxAttempts: 1 };
    await r.tryStart('t', 'w1', opts);
    clock += 200;
    const next = await r.tryStart('t', 'w2', opts);
    expect(next.ok).toBe(false);
    expect(!next.ok && next.record.status).toBe('failed');
  });

  it('终态写入后 tryStart 返回 settled，调用方据此回执', async () => {
    const r = new MemoryRunRegistry();
    await r.tryStart('t', 'w1', OPTS);
    expect(await r.finish('t', 'w1', { status: 'done', result: { answer: 42 } })).toBe(true);

    const after = await r.tryStart('t', 'w2', OPTS);
    expect(after.ok).toBe(false);
    expect(!after.ok && after.reason).toBe('settled');
    expect(!after.ok && after.record.result).toEqual({ answer: 42 });
  });

  it('非 owner 写终态被拒 —— 被接管的旧宿主不能覆盖新结果', async () => {
    let clock = 0;
    const r = new MemoryRunRegistry(3_600_000, () => clock);
    await r.tryStart('t', 'w1', { orphanAfterMs: 100 });
    clock += 200;
    await r.tryStart('t', 'w2', { orphanAfterMs: 100 });

    expect(await r.finish('t', 'w1', { status: 'done', result: 'stale' })).toBe(false);
    expect((await r.get('t'))!.status).toBe('running');
  });

  it('终态记录过 TTL 后被回收，同 runId 可以重新开始', async () => {
    let clock = 0;
    const r = new MemoryRunRegistry(1_000, () => clock);
    await r.tryStart('t', 'w1', OPTS);
    await r.finish('t', 'w1', { status: 'done', result: 1 });

    clock += 1_500;
    expect(await r.get('t')).toBeUndefined();
    expect((await r.tryStart('t', 'w1', OPTS)).ok).toBe(true);
  });
});
