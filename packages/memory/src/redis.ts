/**
 * Redis 版运行注册表，见 docs/architecture.md §5.3 与 ADR-0019/0021。
 *
 * **多实例部署必须用它。** Conductor 不保证 callback 回到同一个 worker
 * （队列名只由 taskType[:domain] 构成，workerId 不参与路由，§2.2 已核实），
 * 所以「这个 taskId 的运行现在在谁手上、跑到哪了」必须是共享状态。
 *
 * tryStart 用 Lua 而不是「读-判-写」：并发的多个 worker 同时 poll 到同一个 taskId 时
 * （60 秒 unack 窗口下真实存在），只有一个能拿到所有权，否则会并发跑两遍、重复付费。
 */
import type {
  BlobStore,
  RunOutcomeRecord,
  RunRecord,
  RunRegistry,
  TryStartOptions,
  TryStartResult,
} from '@ca/core';
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_SETTLED_TTL_MS, sha256 } from '@ca/core';

/** 只用到这几个命令，方便替换实现与测试 */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

export interface RedisRunRegistryOptions {
  client: RedisLike;
  /** 键前缀，多租户/多环境共用一个 Redis 时用来隔离 */
  prefix?: string;
  /** 终态记录保留多久，默认 1 小时。必须远大于一次 callback 间隔 */
  settledTtlMs?: number;
}

/**
 * 原子占位。四种结局：
 *   1  取得所有权（新建）
 *   2  取得所有权（接管孤儿）
 *   3  别人正在跑
 *   4  已是终态（含「重启次数用尽」——这条由脚本自己写入 failed）
 */
const TRY_START = `
local key   = KEYS[1]
local owner = ARGV[1]
local now   = tonumber(ARGV[2])
local orphanAfterMs = tonumber(ARGV[3])
local maxAttempts   = tonumber(ARGV[4])
local settledTtlMs  = tonumber(ARGV[5])

local raw = redis.call('GET', key)
if not raw then
  local rec = cjson.encode({
    status = 'running', owner = owner, startedAt = now, updatedAt = now, attempts = 1,
  })
  redis.call('SET', key, rec, 'PX', settledTtlMs)
  return { 1, rec }
end

local rec = cjson.decode(raw)
if rec.status ~= 'running' then
  return { 4, raw }
end

if (now - rec.updatedAt) <= orphanAfterMs then
  return { 3, raw }
end

if rec.attempts >= maxAttempts then
  rec.status = 'failed'
  rec.updatedAt = now
  rec.error = {
    name = 'OrphanedRunError',
    message = '运行宿主连续失联，已达 maxAttempts，不再接管',
    retryable = true,
  }
  local enc = cjson.encode(rec)
  redis.call('SET', key, enc, 'PX', settledTtlMs)
  return { 4, enc }
end

rec.owner = owner
rec.updatedAt = now
rec.attempts = rec.attempts + 1
local enc = cjson.encode(rec)
redis.call('SET', key, enc, 'PX', settledTtlMs)
return { 2, enc }
`;

/** 心跳：只有当前 owner 能刷新。返回 0 表示所有权已易主，调用方应中止运行 */
const HEARTBEAT = `
local key, owner, now, progress, settledTtlMs =
  KEYS[1], ARGV[1], tonumber(ARGV[2]), ARGV[3], tonumber(ARGV[5])
local raw = redis.call('GET', key)
if not raw then return 0 end
local rec = cjson.decode(raw)
if rec.owner ~= owner or rec.status ~= 'running' then return 0 end
rec.updatedAt = now
if progress ~= '' then rec.progress = cjson.decode(progress) end
redis.call('SET', key, cjson.encode(rec), 'PX', settledTtlMs)
return 1
`;

/** 写终态：所有权已易主时忽略，避免旧 owner 覆盖新 owner 的结果 */
const FINISH = `
local key, owner, now, outcome, settledTtlMs =
  KEYS[1], ARGV[1], tonumber(ARGV[2]), ARGV[3], tonumber(ARGV[4])
local raw = redis.call('GET', key)
if not raw then return 0 end
local rec = cjson.decode(raw)
if rec.owner ~= owner then return 0 end
local o = cjson.decode(outcome)
rec.status = o.status
rec.updatedAt = now
if o.result   ~= nil then rec.result   = o.result   end
if o.error    ~= nil then rec.error    = o.error    end
if o.progress ~= nil then rec.progress = o.progress end
redis.call('SET', key, cjson.encode(rec), 'PX', settledTtlMs)
return 1
`;

export class RedisRunRegistry implements RunRegistry {
  private readonly client: RedisLike;
  private readonly prefix: string;
  private readonly settledTtlMs: number;

  constructor(opts: RedisRunRegistryOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix ?? 'ca';
    this.settledTtlMs = opts.settledTtlMs ?? DEFAULT_SETTLED_TTL_MS;
  }

  private key(runId: string): string {
    return `${this.prefix}:run:${runId}`;
  }

  private decode(runId: string, raw: string): RunRecord {
    return { runId, ...(JSON.parse(raw) as Omit<RunRecord, 'runId'>) };
  }

  async tryStart(runId: string, owner: string, opts: TryStartOptions): Promise<TryStartResult> {
    const res = (await this.client.eval(
      TRY_START,
      1,
      this.key(runId),
      owner,
      Date.now(),
      opts.orphanAfterMs,
      opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      this.settledTtlMs,
    )) as [number, string];

    const [code, raw] = res;
    const record = this.decode(runId, raw);
    if (code === 1) return { ok: true, record, takeover: false };
    if (code === 2) return { ok: true, record, takeover: true };
    if (code === 3) return { ok: false, reason: 'running', record };
    return { ok: false, reason: 'settled', record };
  }

  async heartbeat(
    runId: string,
    owner: string,
    progress?: Parameters<RunRegistry['heartbeat']>[2],
  ): Promise<boolean> {
    const ok = (await this.client.eval(
      HEARTBEAT,
      1,
      this.key(runId),
      owner,
      Date.now(),
      progress ? JSON.stringify(progress) : '',
      '',
      this.settledTtlMs,
    )) as number;
    return ok === 1;
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    const raw = await this.client.get(this.key(runId));
    return raw == null ? undefined : this.decode(runId, raw);
  }

  async finish(runId: string, owner: string, outcome: RunOutcomeRecord): Promise<boolean> {
    const ok = (await this.client.eval(
      FINISH,
      1,
      this.key(runId),
      owner,
      Date.now(),
      JSON.stringify(outcome),
      this.settledTtlMs,
    )) as number;
    return ok === 1;
  }

  async drop(runId: string): Promise<void> {
    await this.client.del(this.key(runId));
  }
}

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
