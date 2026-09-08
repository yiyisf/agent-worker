/**
 * Redis 版 BlobStore，见 docs/architecture.md §8。
 *
 * ⚠️ v0.8 之后本包**不再承担运行状态**。extendLease 心跳保证一次执行始终在同一个
 * worker 进程内（ADR-0022），agent 的状态全程在内存里，不需要任何共享存储。
 * 这里剩下的唯一职责是：超过 outputData 预算的结果外置。
 *
 * 这也是可选的 —— 不配 BlobStore 时超预算的结果会按 payloadStrategy 截断。
 */
import type { BlobStore } from '@ca/core';
import { sha256 } from '@ca/core';

/** 只用到这几个命令，方便替换实现与测试 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  quit(): Promise<unknown>;
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
