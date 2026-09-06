/**
 * Journal / 租约 / 存储契约，见 docs/architecture.md §5.1 与 ADR-0003、ADR-0012。
 *
 * journal 记录的是**受管入口的调用**，不是 core 自建循环的每一步；
 * 载荷对 core 不透明（JsonValue），core 只要求可序列化 + 可稳定哈希（§4.5）。
 *
 * `seq` 只用于排序与阅读，**不是身份**；身份是 stepId（见 hash.ts）。
 */
import type { JsonValue } from './spec.js';
import type { Usage } from './gateway.js';
import type { BudgetSnapshot } from './budget.js';

export interface SerializedError {
  name: string;
  message: string;
  retryable: boolean;
}

export type JournalEntry =
  /** 三层合并后的 effective spec 快照，用于追溯「这次运行到底用的什么配置」（§7.2） */
  | { seq: number; kind: 'spec'; hash: string; effective: JsonValue }
  /** ManagedModelGateway 写入 */
  | { seq: number; kind: 'model'; stepId: string; response: JsonValue; usage: Usage }
  /** 非 pure 工具执行前写入意图；只有 intent 而无结果即「模糊重放」（ADR-0005） */
  | { seq: number; kind: 'tool.intent'; stepId: string; tool: string; input: JsonValue; effect: string }
  | { seq: number; kind: 'tool.result'; stepId: string; tool: string; output: JsonValue }
  | { seq: number; kind: 'tool.error'; stepId: string; tool: string; error: SerializedError }
  /** 分片边界：保存引擎的不透明状态与累计用量（用量必须带上，否则每片预算从 0 开始） */
  | { seq: number; kind: 'slice'; index: number; state: JsonValue; budget: BudgetSnapshot }
  | { seq: number; kind: 'suspend'; awaiting: JsonValue; resumeToken: string; state: JsonValue; budget: BudgetSnapshot }
  | { seq: number; kind: 'resume'; payload: JsonValue }
  /** 终态。ADR-0016 用「有没有这条」区分崩溃与业务失败 */
  | { seq: number; kind: 'final'; output: JsonValue; budget: BudgetSnapshot }
  | { seq: number; kind: 'failed'; error: SerializedError; budget: BudgetSnapshot };

/** 租约记录：fenceToken 单调递增，落后的写入一律被拒（§5.3） */
export interface LeaseRecord {
  runKey: string;
  owner: string;
  fenceToken: number;
  expiresAt: number;
}

export interface StateStore {
  /** CAS 抢占；返回 undefined 表示已有更新的 owner，本 worker 应立即放弃 */
  acquire(runKey: string, owner: string, ttlMs: number): Promise<LeaseRecord | undefined>;
  renew(lease: LeaseRecord, ttlMs: number): Promise<LeaseRecord | undefined>;
  release(lease: LeaseRecord): Promise<void>;

  readJournal(runKey: string): Promise<JournalEntry[]>;
  /** 携带 fenceToken；落后则抛 FencedOutError */
  appendJournal(lease: LeaseRecord, entries: JournalEntry[]): Promise<void>;
  dropJournal(runKey: string): Promise<void>;
}

export interface BlobStore {
  put(
    key: string,
    body: Uint8Array | string,
    contentType?: string,
  ): Promise<{ ref: string; bytes: number; sha256: string }>;
  get(ref: string): Promise<Uint8Array>;
}

/**
 * 写入时的条目形状（seq 由 RunJournal 分配）。
 * 必须用可分配的 Omit —— 直接 `Omit<JournalEntry, 'seq'>` 会把联合类型塌缩成公共键。
 */
export type JournalEntryInput = JournalEntry extends infer T
  ? T extends JournalEntry
    ? Omit<T, 'seq'>
    : never
  : never;

/** journal 里是否有终态 —— ADR-0016 的恢复判据 */
export function hasTerminalEntry(entries: readonly JournalEntry[]): boolean {
  return entries.some((e) => e.kind === 'final' || e.kind === 'failed');
}
