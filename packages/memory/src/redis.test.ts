/**
 * 没有 Redis 就跳过而不是失败：
 *   redis-server --port 6380 --daemonize yes
 */
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { RedisBlobStore, type RedisLike } from './redis.js';

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

describe.skipIf(!live)('RedisBlobStore（需要 Redis）', () => {
  it('存取往返一致', async () => {
    const client = new Redis(URL);
    try {
      const store = new RedisBlobStore(client as unknown as RedisLike, `catest:blob:${Date.now()}`);
      const put = await store.put('result', JSON.stringify({ a: 1 }));
      expect(put.bytes).toBeGreaterThan(0);
      expect(put.sha256).toHaveLength(64);
      expect(new TextDecoder().decode(await store.get(put.ref))).toBe('{"a":1}');
    } finally {
      await client.quit();
    }
  }, 15_000);

  it('取不存在的 ref 明确报错，不返回空内容', async () => {
    const client = new Redis(URL);
    try {
      const store = new RedisBlobStore(client as unknown as RedisLike, `catest:blob:${Date.now()}`);
      await expect(store.get('catest:blob:nope')).rejects.toThrow(/not found/);
    } finally {
      await client.quit();
    }
  }, 15_000);
});
