/**
 * 内存版 StateStore / BlobStore。
 *
 * ⚠️ 仅供本地开发与单测。生产的 callback 分片策略要求持久化实现（§8），
 * `createAgentWorker` 会在启动时拒绝内存实现。
 *
 * 它同时是 fencing 语义的参考实现：租约记录带单调递增的 fenceToken，
 * 落后的写入一律被拒（§5.3）。
 */
import type { BlobStore, JournalEntry, LeaseRecord, StateStore } from '../journal.js';
import { FencedOutError } from '../errors.js';
import { sha256 } from '../hash.js';

interface Slot {
  fenceToken: number;
  owner: string;
  expiresAt: number;
  journal: JournalEntry[];
}

export class MemoryStateStore implements StateStore {
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(runKey: string, owner: string, ttlMs: number): Promise<LeaseRecord | undefined> {
    const t = this.now();
    const slot = this.slots.get(runKey);
    if (!slot) {
      const fresh: Slot = { fenceToken: 1, owner, expiresAt: t + ttlMs, journal: [] };
      this.slots.set(runKey, fresh);
      return { runKey, owner, fenceToken: 1, expiresAt: fresh.expiresAt };
    }
    // 租约未过期且属于别人 → 抢占失败，调用方应立即放弃
    if (slot.expiresAt > t && slot.owner !== owner) return undefined;
    slot.fenceToken += 1;
    slot.owner = owner;
    slot.expiresAt = t + ttlMs;
    return { runKey, owner, fenceToken: slot.fenceToken, expiresAt: slot.expiresAt };
  }

  async renew(lease: LeaseRecord, ttlMs: number): Promise<LeaseRecord | undefined> {
    const slot = this.slots.get(lease.runKey);
    if (!slot || slot.fenceToken !== lease.fenceToken) return undefined;
    slot.expiresAt = this.now() + ttlMs;
    return { ...lease, expiresAt: slot.expiresAt };
  }

  async release(lease: LeaseRecord): Promise<void> {
    const slot = this.slots.get(lease.runKey);
    if (slot && slot.fenceToken === lease.fenceToken) slot.expiresAt = 0;
  }

  async readJournal(runKey: string): Promise<JournalEntry[]> {
    return [...(this.slots.get(runKey)?.journal ?? [])];
  }

  async appendJournal(lease: LeaseRecord, entries: JournalEntry[]): Promise<void> {
    const slot = this.slots.get(lease.runKey);
    if (!slot) throw new FencedOutError(lease.runKey, lease.fenceToken, 0);
    if (slot.fenceToken !== lease.fenceToken) {
      throw new FencedOutError(lease.runKey, lease.fenceToken, slot.fenceToken);
    }
    slot.journal.push(...entries);
  }

  async dropJournal(runKey: string): Promise<void> {
    const slot = this.slots.get(runKey);
    if (slot) slot.journal = [];
  }
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, body: Uint8Array | string): Promise<{ ref: string; bytes: number; sha256: string }> {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const digest = sha256(Buffer.from(bytes).toString('utf8'));
    const ref = `mem://${key}/${digest.slice(0, 16)}`;
    this.blobs.set(ref, bytes);
    return { ref, bytes: bytes.byteLength, sha256: digest };
  }

  async get(ref: string): Promise<Uint8Array> {
    const found = this.blobs.get(ref);
    if (!found) throw new Error(`blob not found: ${ref}`);
    return found;
  }
}
