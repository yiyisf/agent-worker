/** Journaled Replay，见 docs/architecture.md §5.1 与 ADR-0003。占位：仅声明契约。 */
import type { EffectClass } from './tool.js';
import type { ModelResponse, Usage } from './model.js';

export type StepKind = 'plan' | 'act' | 'observe' | 'finalize';

export interface SerializedError {
  name: string;
  message: string;
  retryable: boolean;
  stack?: string;
}

export type JournalEntry =
  | { seq: number; kind: 'model'; stepId: string; requestHash: string; response: ModelResponse; usage: Usage }
  | { seq: number; kind: 'tool.intent'; stepId: string; tool: string; input: unknown; effect: EffectClass }
  | { seq: number; kind: 'tool.result'; stepId: string; output: unknown }
  | { seq: number; kind: 'tool.error'; stepId: string; error: SerializedError }
  | { seq: number; kind: 'suspend'; seqRef: number; resumeToken: string }
  | { seq: number; kind: 'resume'; seqRef: number; payload: unknown }
  | { seq: number; kind: 'final'; output: unknown };

/** 租约记录：fenceToken 单调递增，落后的写入一律被拒（§5.3） */
export interface LeaseRecord {
  runKey: string;
  owner: string;
  fenceToken: number;
  expiresAt: number;
}

export interface StateStore {
  /** CAS 抢占租约；返回 undefined 表示抢占失败 */
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
