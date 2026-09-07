/**
 * 运行注册表 —— 异步化模型下唯一需要的共享设施，见 docs/architecture.md §5 与 ADR-0019/0020。
 *
 * 它只回答一个问题：**这个 runId 的运行现在处于什么状态？**
 *   没有       → 本 worker 取得所有权，发起运行
 *   正在跑     → 交还任务，下次 callback 再来看
 *   跑完了     → 读结果，回执终态
 *   宿主死了   → 按 onOrphan 处理（默认由本 worker 接管重跑）
 *
 * runId 直接用 Conductor 的 **taskId**（ADR-0020）：
 *   同一次执行的多次 callback → 同一个 taskId
 *   重试 / 新工作流实例       → 新的 taskId
 * 不需要自己拼 workflowInstanceId:refName:epoch —— 引擎已经给了语义完全吻合的标识。
 */
import type { JsonValue } from './spec.js';
import type { SerializedError } from './errors.js';
import type { ProgressReport } from './progress.js';

export type RunStatus = 'running' | 'done' | 'failed';

export interface RunRecord {
  runId: string;
  status: RunStatus;
  /** 发起这次运行的 worker 实例标识 */
  owner: string;
  startedAt: number;
  /** 最近一次心跳/状态变更时间。running 且久未更新即判定宿主已死 */
  updatedAt: number;
  /** 累计已发起的运行次数（含孤儿重启），用于诊断与「重启几次就放弃」 */
  attempts: number;
  progress?: ProgressReport;
  result?: JsonValue;
  error?: SerializedError;
}

export type TryStartResult =
  /** 取得所有权，调用方应当发起运行。takeover=true 表示接管了一个孤儿运行 */
  | { ok: true; record: RunRecord; takeover: boolean }
  /** 别人正在跑，交还任务等下次 callback */
  | { ok: false; reason: 'running'; record: RunRecord }
  /** 已是终态，读 record.result / record.error 直接回执 */
  | { ok: false; reason: 'settled'; record: RunRecord };

export interface TryStartOptions {
  /** running 记录超过这么久没心跳就认定宿主已死，可被接管 */
  orphanAfterMs: number;
  /** 最多允许发起几次（含接管重启）。超过则 tryStart 返回 settled + failed */
  maxAttempts?: number;
}

export interface RunOutcomeRecord {
  status: 'done' | 'failed';
  result?: JsonValue;
  error?: SerializedError;
  progress?: ProgressReport;
}

export interface RunRegistry {
  /** **原子**占位。并发的多个 worker 同时调用，只有一个能拿到 ok:true */
  tryStart(runId: string, owner: string, opts: TryStartOptions): Promise<TryStartResult>;
  /** 刷新心跳与进展。返回 false 表示所有权已被别人接管，调用方应中止本次运行 */
  heartbeat(runId: string, owner: string, progress?: ProgressReport): Promise<boolean>;
  get(runId: string): Promise<RunRecord | undefined>;
  /** 写终态。所有权已易主时忽略写入并返回 false */
  finish(runId: string, owner: string, outcome: RunOutcomeRecord): Promise<boolean>;
  /** 终态记录被消费（已回执给编排引擎）后清理 */
  drop(runId: string): Promise<void>;
}

/** 终态记录保留多久 —— 必须比一次 callback 间隔长得多，否则结果会在被读走前消失 */
export const DEFAULT_SETTLED_TTL_MS = 3_600_000;
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 单进程实现。默认值 —— 一个 worker 进程独享时它就是全部。
 * 多实例部署必须换成共享实现（@ca/memory 的 RedisRunRegistry），
 * 因为 Conductor **不保证** callback 回到同一个 worker（§2.2）。
 */
export class MemoryRunRegistry implements RunRegistry {
  private readonly runs = new Map<string, RunRecord>();

  constructor(
    private readonly settledTtlMs: number = DEFAULT_SETTLED_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async tryStart(runId: string, owner: string, opts: TryStartOptions): Promise<TryStartResult> {
    const t = this.now();
    this.evictExpired(t);
    const existing = this.runs.get(runId);
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    if (!existing) {
      const record: RunRecord = {
        runId, status: 'running', owner, startedAt: t, updatedAt: t, attempts: 1,
      };
      this.runs.set(runId, record);
      return { ok: true, record: { ...record }, takeover: false };
    }

    if (existing.status !== 'running') {
      return { ok: false, reason: 'settled', record: { ...existing } };
    }

    const stale = t - existing.updatedAt > opts.orphanAfterMs;
    if (!stale) return { ok: false, reason: 'running', record: { ...existing } };

    if (existing.attempts >= maxAttempts) {
      const failed: RunRecord = {
        ...existing,
        status: 'failed',
        updatedAt: t,
        error: {
          name: 'OrphanedRunError',
          message:
            `运行宿主连续 ${existing.attempts} 次失联（每次超过 ${opts.orphanAfterMs}ms 无心跳），` +
            `已达 maxAttempts=${maxAttempts}，不再接管`,
          retryable: true,
        },
      };
      this.runs.set(runId, failed);
      return { ok: false, reason: 'settled', record: { ...failed } };
    }

    const taken: RunRecord = {
      ...existing, owner, updatedAt: t, attempts: existing.attempts + 1,
    };
    this.runs.set(runId, taken);
    return { ok: true, record: { ...taken }, takeover: true };
  }

  async heartbeat(runId: string, owner: string, progress?: ProgressReport): Promise<boolean> {
    const rec = this.runs.get(runId);
    if (!rec || rec.owner !== owner || rec.status !== 'running') return false;
    rec.updatedAt = this.now();
    if (progress) rec.progress = progress;
    return true;
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    this.evictExpired(this.now());
    const rec = this.runs.get(runId);
    return rec ? { ...rec } : undefined;
  }

  async finish(runId: string, owner: string, outcome: RunOutcomeRecord): Promise<boolean> {
    const rec = this.runs.get(runId);
    if (!rec || rec.owner !== owner) return false;
    rec.status = outcome.status;
    rec.updatedAt = this.now();
    if (outcome.result !== undefined) rec.result = outcome.result;
    if (outcome.error !== undefined) rec.error = outcome.error;
    if (outcome.progress !== undefined) rec.progress = outcome.progress;
    return true;
  }

  async drop(runId: string): Promise<void> {
    this.runs.delete(runId);
  }

  private evictExpired(t: number): void {
    for (const [id, rec] of this.runs) {
      if (rec.status !== 'running' && t - rec.updatedAt > this.settledTtlMs) this.runs.delete(id);
    }
  }
}
