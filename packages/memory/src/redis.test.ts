import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { MemoryStateStore } from '@ca/core';
import { checkStateStoreConformance } from '@ca/testing';
import { RedisBlobStore, RedisStateStore, type RedisLike } from './redis.js';

// 本地 redis-server；没有就跳过（在 CI 上由服务容器提供）
const REDIS_URL = process.env.CA_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';

describe('StateStore 契约 —— 内存实现', () => {
  it('零违规', async () => {
    expect(await checkStateStoreConformance((now) => new MemoryStateStore(now))).toEqual([]);
  });
});

const clients: Redis[] = [];
const connect = (): Redis => {
  const c = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  clients.push(c);
  return c;
};

let reachable = false;
try {
  const probe = connect();
  await probe.connect();
  await probe.ping();
  reachable = true;
} catch {
  reachable = false;
}

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.quit()));
});

describe.skipIf(!reachable)('StateStore 契约 —— Redis 实现', () => {
  it('零违规（与内存实现受同一套断言约束）', async () => {
    const client = connect();
    await client.connect();
    const violations = await checkStateStoreConformance(
      (now) => new RedisStateStore({ client: client as unknown as RedisLike, prefix: 'ca-test' }, now),
    );
    expect(violations).toEqual([]);
  });

  it('并发抢占：只有一个 worker 拿得到租约', async () => {
    const client = connect();
    await client.connect();
    const store = new RedisStateStore({ client: client as unknown as RedisLike, prefix: 'ca-test' });
    const key = `race-${Math.random().toString(36).slice(2)}`;
    // Lua 保证判过期与递增 fence 是原子的，所以并发下只能有一个赢家
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.acquire(key, `w${i}`, 30_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('BlobStore 往返一致', async () => {
    const client = connect();
    await client.connect();
    const blobs = new RedisBlobStore(client as unknown as RedisLike, 'ca-test:blob');
    const { ref, bytes } = await blobs.put('transcript', '你好，世界');
    expect(bytes).toBe(Buffer.byteLength('你好，世界', 'utf8'));
    expect(new TextDecoder().decode(await blobs.get(ref))).toBe('你好，世界');
  });
});
