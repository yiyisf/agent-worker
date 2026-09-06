/**
 * Redis 版 StateStore，见 docs/architecture.md §5.3、§8。
 *
 * 默认的 callback 分片策略要求持久化 StateStore —— 内存实现只供本地开发。
 *
 * 三处必须用 Lua 而不是「读-判-写」的地方，都是因为 fencing 的正确性依赖原子性：
 *   acquire        判租约是否过期 + 递增 fenceToken 必须原子
 *   appendJournal  校验 fenceToken + 追加条目必须原子（否则会写进落后 worker 的数据）
 *   renew/release  同理，只有持有当前 fence 的人才能改
 */
import type { BlobStore, JournalEntry, LeaseRecord, StateStore } from '@ca/core';
import { FencedOutError, sha256 } from '@ca/core';

/** 只用到这几个命令，方便替换实现与测试 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  del(...keys: string[]): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface RedisStateStoreOptions {
  client: RedisLike;
  /** 键前缀，多租户/多环境共用一个 Redis 时用来隔离 */
  prefix?: string;
  /** journal 的保留时长，默认 7 天（§8 的排障 TTL） */
  journalTtlMs?: number;
}

/**
 * 抢占：租约不存在、已过期、或本来就是自己的 → 递增 fence 并接管；
 * 否则返回 nil 表示抢不到（调用方必须立即放弃，不能并发跑）。
 */
const ACQUIRE = `
local leaseKey, owner, ttl, now = KEYS[1], ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local cur = redis.call('HMGET', leaseKey, 'owner', 'fence', 'expiresAt')
local fence = tonumber(cur[2])
if fence ~= nil and cur[1] ~= owner and tonumber(cur[3]) > now then
  return nil
end
local nextFence = (fence or 0) + 1
local expiresAt = now + ttl
redis.call('HSET', leaseKey, 'owner', owner, 'fence', nextFence, 'expiresAt', expiresAt)
redis.call('PEXPIRE', leaseKey, ttl + 86400000)
return { nextFence, expiresAt }
`;

/** 续租：只有持有当前 fence 的人才能续 */
const RENEW = `
local leaseKey, fence, ttl, now = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
if tonumber(redis.call('HGET', leaseKey, 'fence')) ~= fence then return nil end
local expiresAt = now + ttl
redis.call('HSET', leaseKey, 'expiresAt', expiresAt)
redis.call('PEXPIRE', leaseKey, ttl + 86400000)
return expiresAt
`;

/** 释放：把过期时间抹掉，让下一个 worker 能立刻接管 */
const RELEASE = `
local leaseKey, fence = KEYS[1], tonumber(ARGV[1])
if tonumber(redis.call('HGET', leaseKey, 'fence')) ~= fence then return 0 end
redis.call('HSET', leaseKey, 'expiresAt', 0)
return 1
`;

/**
 * 追加 journal：**先校验 fence 再写**，两步必须原子。
 * 返回当前 fence 供调用方在落后时构造精确的错误信息。
 */
const APPEND = `
local leaseKey, journalKey = KEYS[1], KEYS[2]
local fence, ttl = tonumber(ARGV[1]), tonumber(ARGV[2])
local cur = tonumber(redis.call('HGET', leaseKey, 'fence'))
if cur ~= fence then return { 0, cur or 0 } end
for i = 3, #ARGV do
  redis.call('RPUSH', journalKey, ARGV[i])
end
redis.call('PEXPIRE', journalKey, ttl)
return { 1, cur }
`;

export class RedisStateStore implements StateStore {
  private readonly prefix: string;
  private readonly journalTtlMs: number;

  constructor(
    private readonly opts: RedisStateStoreOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.prefix = opts.prefix ?? 'ca';
    this.journalTtlMs = opts.journalTtlMs ?? 7 * 24 * 3600_000;
  }

  private leaseKey(runKey: string): string {
    return `${this.prefix}:lease:${runKey}`;
  }
  private journalKey(runKey: string): string {
    return `${this.prefix}:journal:${runKey}`;
  }

  async acquire(runKey: string, owner: string, ttlMs: number): Promise<LeaseRecord | undefined> {
    const res = (await this.opts.client.eval(
      ACQUIRE,
      1,
      this.leaseKey(runKey),
      owner,
      ttlMs,
      this.now(),
    )) as [number, number] | null;
    if (!res) return undefined;
    return { runKey, owner, fenceToken: Number(res[0]), expiresAt: Number(res[1]) };
  }

  async renew(lease: LeaseRecord, ttlMs: number): Promise<LeaseRecord | undefined> {
    const res = (await this.opts.client.eval(
      RENEW,
      1,
      this.leaseKey(lease.runKey),
      lease.fenceToken,
      ttlMs,
      this.now(),
    )) as number | null;
    if (res == null) return undefined;
    return { ...lease, expiresAt: Number(res) };
  }

  async release(lease: LeaseRecord): Promise<void> {
    await this.opts.client.eval(RELEASE, 1, this.leaseKey(lease.runKey), lease.fenceToken);
  }

  async readJournal(runKey: string): Promise<JournalEntry[]> {
    const raw = await this.opts.client.lrange(this.journalKey(runKey), 0, -1);
    return raw.map((s) => JSON.parse(s) as JournalEntry);
  }

  async appendJournal(lease: LeaseRecord, entries: JournalEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const res = (await this.opts.client.eval(
      APPEND,
      2,
      this.leaseKey(lease.runKey),
      this.journalKey(lease.runKey),
      lease.fenceToken,
      this.journalTtlMs,
      ...entries.map((e) => JSON.stringify(e)),
    )) as [number, number];
    if (Number(res[0]) !== 1) {
      throw new FencedOutError(lease.runKey, lease.fenceToken, Number(res[1]));
    }
  }

  async dropJournal(runKey: string): Promise<void> {
    await this.opts.client.del(this.journalKey(runKey));
  }
}

/**
 * Redis 版 BlobStore。大对象（transcript、超限 payload）走这里，
 * 但生产更适合放对象存储 —— Redis 只是让本地与小规模部署少一个依赖。
 */
export class RedisBlobStore implements BlobStore {
  constructor(
    private readonly client: RedisLike,
    private readonly prefix = 'ca:blob',
    private readonly ttlMs = 30 * 24 * 3600_000,
  ) {}

  async put(key: string, body: Uint8Array | string): Promise<{ ref: string; bytes: number; sha256: string }> {
    const text = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
    const digest = sha256(text);
    const ref = `${this.prefix}:${key}:${digest.slice(0, 16)}`;
    await this.client.set(ref, text, 'PX', this.ttlMs);
    return { ref, bytes: Buffer.byteLength(text, 'utf8'), sha256: digest };
  }

  async get(ref: string): Promise<Uint8Array> {
    const found = await this.client.get(ref);
    if (found == null) throw new Error(`blob not found: ${ref}`);
    return new TextEncoder().encode(found);
  }
}
