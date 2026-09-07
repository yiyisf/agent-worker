/**
 * RedisRunRegistry 跑与内存版**完全相同**的一致性断言 —— 注册表是异步化模型的正确性支点，
 * 两种实现在并发与接管语义上不能有差异。
 *
 * 没有 Redis 就跳过而不是失败：
 *   redis-server --port 6380 --daemonize yes
 */
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { checkRunRegistryConformance } from '@ca/testing';
import { RedisBlobStore, RedisRunRegistry, type RedisLike } from './redis.js';

const URL = process.env.CA_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';

async function reachable(): Promise<boolean> {
  try {
    const c = new Redis(URL, { lazyConnect: true, retryStrategy: () => null });
    await c.connect();
    await c.ping();
    await c.quit();
    return true;
  } catch {
    return false;
  }
}

const live = await reachable();
if (!live) console.warn(`[memory] 跳过：连不上 Redis(${URL})`);

describe.skipIf(!live)('RedisRunRegistry（需要 Redis）', () => {
  it('通过运行注册表一致性套件', async () => {
    const client = new Redis(URL);
    try {
      let n = 0;
      const violations = await checkRunRegistryConformance({
        async create() {
          n += 1;
          const prefix = `catest:${Date.now()}:${n}`;
          return {
            registry: new RedisRunRegistry({ client: client as unknown as RedisLike, prefix }),
            runId: 'task-1',
          };
        },
      });
      expect(violations).toEqual([]);
    } finally {
      await client.quit();
    }
  }, 30_000);

  it('真并发：多个客户端抢同一个 runId，只有一个能拿到所有权', async () => {
    const clients = Array.from({ length: 5 }, () => new Redis(URL));
    try {
      const prefix = `catest:race:${Date.now()}`;
      const results = await Promise.all(
        clients.map((c, i) =>
          new RedisRunRegistry({ client: c as unknown as RedisLike, prefix }).tryStart(
            'task-1',
            `w${i}`,
            { orphanAfterMs: 60_000 },
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  }, 30_000);

  it('BlobStore 存取往返一致', async () => {
    const client = new Redis(URL);
    try {
      const store = new RedisBlobStore(client as unknown as RedisLike, `catest:blob:${Date.now()}`);
      const put = await store.put('result', JSON.stringify({ a: 1 }));
      expect(put.bytes).toBeGreaterThan(0);
      expect(new TextDecoder().decode(await store.get(put.ref))).toBe('{"a":1}');
    } finally {
      await client.quit();
    }
  }, 15_000);
});
