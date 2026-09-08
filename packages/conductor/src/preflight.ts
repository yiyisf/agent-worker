/**
 * 启动自检，见 docs/architecture.md §6.8。
 *
 * 设计里有好几处写着「启动时拒绝」「启动时告警」，本模块是它们**唯一的落地点**。
 * 它检查三件事，每件都对应一个「不检查就会在线上以难懂的方式炸掉」的场景：
 *
 *   1. 服务端支不支持 extendLease（< 3.10.7 就不支持）
 *      不检查 → 长任务在第一个 responseTimeout 时被判 TIMED_OUT，看起来像"agent 太慢"
 *   2. 线上 TaskDef 与本地推导是否漂移
 *      不检查 → 别人把 responseTimeoutSeconds 调到 1.25 以下，官方心跳静默跳过，同上
 *   3. （由 progress 模块在首次写日志后实测）task log 到底存不存得下
 *      不检查 → 用户以为进展写出去了，其实被 NoopIndexDAO 丢了
 *
 * 刻意做成**注入数据源的纯函数**：它不认识 HTTP 客户端，方便测试，
 * 也方便已有工程用自己的客户端接进来。`httpPreflightSource()` 提供开箱即用的实现。
 */
import type { Logger } from '@ca/core';
import { diffTaskDefs, type DerivedTaskDef, type TaskDefDrift } from './taskdef.js';
import { EXTEND_LEASE_MIN_SERVER_VERSION, OFFICIAL_LEASE_EXTEND, supportsExtendLease } from './lease.js';
import type { FetchLike } from './external-payload.js';

export interface PreflightSource {
  /** GET {serverUrl}/admin/config —— 里面有 build 的 version */
  fetchServerConfig(): Promise<Record<string, unknown>>;
  /** GET {serverUrl}/metadata/taskdefs */
  fetchTaskDefs(): Promise<Partial<DerivedTaskDef>[]>;
}

export interface PreflightOptions {
  taskDefs: readonly DerivedTaskDef[];
  source: PreflightSource;
  logger?: Logger;
  /** 检查不通过时抛错，默认 true。设 false 只收集报告不阻塞（灰度期有用） */
  strict?: boolean;
}

export interface PreflightReport {
  /** 取不到就是 undefined —— 取不到本身不算失败，只降级为告警 */
  serverVersion?: string;
  extendLeaseSupported: boolean | 'unknown';
  drift: TaskDefDrift[];
  /** 致命问题：strict 模式下会抛 */
  problems: string[];
  warnings: string[];
  ok: boolean;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** `/admin/config` 返回的是 System.getProperties() + build 属性，版本在 `version` 键上 */
export function serverVersionOf(config: Record<string, unknown>): string | undefined {
  for (const key of ['version', 'conductor.build.version', 'build.version']) {
    const v = config[key];
    if (typeof v === 'string' && /\d+\.\d+/.test(v)) return v;
  }
  return undefined;
}

export async function preflight(opts: PreflightOptions): Promise<PreflightReport> {
  const logger = opts.logger ?? noopLogger;
  const problems: string[] = [];
  const warnings: string[] = [];

  // ── 1. 服务端版本与 extendLease 支持 ──
  let serverVersion: string | undefined;
  let extendLeaseSupported: boolean | 'unknown' = 'unknown';
  try {
    serverVersion = serverVersionOf(await opts.source.fetchServerConfig());
    if (serverVersion) {
      extendLeaseSupported = supportsExtendLease(serverVersion);
      if (!extendLeaseSupported) {
        problems.push(
          `服务端版本 ${serverVersion} 不支持 extendLease（需要 ≥ ${EXTEND_LEASE_MIN_SERVER_VERSION}）。` +
            `本 SDK 依赖它保证「一次执行始终在同一 worker」，长任务会在第一个 ` +
            `responseTimeout 时被判 TIMED_OUT。`,
        );
      }
    } else {
      warnings.push(
        '拿不到服务端版本号（/admin/config 里没有 version 键），跳过 extendLease 版本检查。' +
          `请自行确认服务端 ≥ ${EXTEND_LEASE_MIN_SERVER_VERSION}。`,
      );
    }
  } catch (err) {
    warnings.push(`读取 /admin/config 失败，跳过版本检查：${(err as Error)?.message}`);
  }

  // ── 2. TaskDef 漂移 ──
  let drift: TaskDefDrift[] = [];
  try {
    drift = diffTaskDefs(opts.taskDefs, await opts.source.fetchTaskDefs());
  } catch (err) {
    warnings.push(`读取 /metadata/taskdefs 失败，跳过漂移检查：${(err as Error)?.message}`);
  }

  for (const d of drift) {
    if (d.field === '*') {
      warnings.push(`TaskDef "${d.name}" 线上不存在，记得先 registerTask`);
      continue;
    }
    const line = `TaskDef "${d.name}" 的 ${d.field} 发生漂移：本地 ${String(d.local)} / 线上 ${String(d.remote)}`;
    // responseTimeoutSeconds 的漂移是唯一会导致**静默失效**的那种，单独升级为致命
    if (d.field === 'responseTimeoutSeconds') {
      const remote = Number(d.remote);
      if (Number.isFinite(remote) && remote < OFFICIAL_LEASE_EXTEND.minResponseTimeoutSeconds) {
        problems.push(
          `${line} —— 线上值 < ${OFFICIAL_LEASE_EXTEND.minResponseTimeoutSeconds}，` +
            `官方 LeaseTracker 会**静默跳过心跳**（算出的间隔 < 1000ms），任务必然被判超时。`,
        );
        continue;
      }
      warnings.push(`${line}（心跳间隔与崩溃检测灵敏度会跟着变，注意是否有意为之）`);
      continue;
    }
    if (d.field === 'retryCount' && Number(d.remote) === 0) {
      problems.push(
        `${line} —— retryCount = 0 意味着 worker 崩溃后任务不会被重新分配，直接失败。`,
      );
      continue;
    }
    warnings.push(line);
  }

  for (const w of warnings) logger.warn(`[preflight] ${w}`);
  for (const p of problems) logger.error(`[preflight] ${p}`);

  const report: PreflightReport = {
    ...(serverVersion ? { serverVersion } : {}),
    extendLeaseSupported,
    drift,
    problems,
    warnings,
    ok: problems.length === 0,
  };

  if (!report.ok && (opts.strict ?? true)) {
    throw new Error(`启动自检未通过：\n  - ${problems.join('\n  - ')}`);
  }
  return report;
}

/** 用裸 HTTP 拼一个数据源；已有工程也可以用自己的客户端实现 PreflightSource */
export function httpPreflightSource(opts: {
  serverUrl: string;
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
}): PreflightSource {
  const base = opts.serverUrl.replace(/\/$/, '');
  const f = (opts.fetchImpl ?? (globalThis as { fetch?: unknown }).fetch) as FetchLike | undefined;
  if (typeof f !== 'function') {
    throw new Error('当前运行时没有全局 fetch，请通过 fetchImpl 注入一个实现');
  }
  const get = async (path: string): Promise<unknown> => {
    const res = await f(`${base}${path}`, { headers: opts.headers ?? {} });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    return res.json();
  };
  return {
    async fetchServerConfig() {
      return (await get('/admin/config')) as Record<string, unknown>;
    },
    async fetchTaskDefs() {
      return (await get('/metadata/taskdefs')) as Partial<DerivedTaskDef>[];
    },
  };
}
