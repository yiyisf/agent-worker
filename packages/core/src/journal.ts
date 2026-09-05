/**
 * Journal / 租约 / 存储契约，见 docs/architecture.md §5.1、§8 与 ADR-0003、ADR-0012。占位。
 *
 * v0.4 变化：journal 记录的是**受管入口的调用**，不再是 core 自建循环的每一步；
 * 载荷对 core 不透明（JsonValue），core 只要求可序列化 + 可稳定哈希（§4.5）。
 */
import type { JsonValue } from './spec.js';
import type { Usage } from './gateway.js';

export interface SerializedError {
  name: string;
  message: string;
  retryable: boolean;
}

export type JournalEntry =
  /** ManagedModelGateway 命中/写入 */
  | { seq: number; kind: 'model'; stepId: string; requestHash: string; response: JsonValue; usage: Usage }
  /** 工具执行前写入意图；只有 intent 而无 result 即「模糊重放」（ADR-0005） */
  | { seq: number; kind: 'tool.intent'; stepId: string; tool: string; input: JsonValue; effect: string }
  | { seq: number; kind: 'tool.result'; stepId: string; output: JsonValue }
  | { seq: number; kind: 'tool.error'; stepId: string; error: SerializedError }
  /** 分片边界：保存引擎的不透明状态；超阈值时外置到 BlobStore 并留 ref */
  | { seq: number; kind: 'slice'; index: number; state: JsonValue | { ref: string } }
  | { seq: number; kind: 'suspend'; awaiting: JsonValue; resumeToken: string }
  | { seq: number; kind: 'resume'; payload: JsonValue }
  /** 三层合并后的 effective spec 快照，用于追溯「这次运行到底用的什么配置」（§7.2） */
  | { seq: number; kind: 'spec'; hash: string; effective: JsonValue }
  | { seq: number; kind: 'final'; output: JsonValue };

/** 租约记录：fenceToken 单调递增，落后的写入一律被拒（§5.3） */
export interface LeaseRecord {
  runKey: string;
  owner: string;
  fenceToken: number;
  expiresAt: number;
}

export interface StateStore {
  acquire(runKey: string, owner: string, ttlMs: number): Promise<LeaseRecord | undefined>;
  renew(lease: LeaseRecord, ttlMs: number): Promise<LeaseRecord | undefined>;
  release(lease: LeaseRecord): Promise<void>;

  readJournal(runKey: string): Promise<JournalEntry[]>;
  /** 携带 fenceToken；落后则抛 FencedOutError */
  appendJournal(lease: LeaseRecord, entries: JournalEntry[]): Promise<void>;
  dropJournal(runKey: string): Promise<void>;
}

export interface BlobStore {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<{ ref: string; bytes: number; sha256: string }>;
  get(ref: string): Promise<Uint8Array>;
}
