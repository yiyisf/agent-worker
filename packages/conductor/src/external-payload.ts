/**
 * 外置 payload 的取回，见 docs/architecture.md §6.5。
 *
 * 为什么必须有这个：输入超过 `taskInputPayloadSizeThreshold`（默认 3072 KB）时，
 * 服务端的 `TaskModel.externalizeInput()` 会把 `inputData` **清空**、只留
 * `externalInputPayloadStoragePath`；而官方 JS SDK **完全不处理这个字段**
 * （在它的 src 里除生成类型外零引用）。不显式取回就会静默拿到 `{}` ——
 * agent 会基于空输入烧一遍 token 并给出错误答案。
 *
 * 取回是两跳（源码核实）：
 *   1. GET {serverUrl}/tasks/externalstoragelocation?path=…&operation=READ&payloadType=TASK_INPUT
 *      → ExternalStorageLocation { uri, path }
 *   2. GET uri → 真正的 JSON
 *
 * 第一跳返回的 `uri` 通常是带签名的直链（S3 presigned URL / Azure SAS），
 * 所以第二跳**不该**带 Conductor 的鉴权头。
 */
import type { ExternalInputResolver } from './task-io.js';

export type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface ExternalPayloadOptions {
  /** Conductor REST 根路径，如 http://localhost:8080/api */
  serverUrl: string;
  /** 第一跳（问 Conductor 要下载地址）需要的鉴权头 */
  headers?: Record<string, string>;
  /** 注入以便测试；默认用全局 fetch */
  fetchImpl?: FetchLike;
}

export interface ExternalStorageLocation {
  uri: string;
  path: string;
}

function requireFetch(f?: FetchLike): FetchLike {
  if (f) return f;
  const g = (globalThis as { fetch?: unknown }).fetch;
  if (typeof g !== 'function') {
    throw new Error('当前运行时没有全局 fetch，请通过 fetchImpl 注入一个实现');
  }
  return g as unknown as FetchLike;
}

/** 问 Conductor 要一个可下载的地址 */
export async function getExternalStorageLocation(
  opts: ExternalPayloadOptions & { path: string; payloadType: 'TASK_INPUT' | 'TASK_OUTPUT' },
): Promise<ExternalStorageLocation> {
  const fetchImpl = requireFetch(opts.fetchImpl);
  const q = new URLSearchParams({
    path: opts.path,
    operation: 'READ',
    payloadType: opts.payloadType,
  });
  const url = `${opts.serverUrl.replace(/\/$/, '')}/tasks/externalstoragelocation?${q.toString()}`;
  const res = await fetchImpl(url, { headers: opts.headers ?? {} });
  if (!res.ok) {
    throw new Error(`取外置存储地址失败：HTTP ${res.status} ${await res.text()}`);
  }
  const loc = (await res.json()) as Partial<ExternalStorageLocation>;
  if (!loc?.uri) {
    throw new Error(`取外置存储地址失败：响应里没有 uri（${JSON.stringify(loc)}）`);
  }
  return { uri: loc.uri, path: loc.path ?? opts.path };
}

/**
 * 开箱即用的大输入取回器，直接传给 `createAgentWorker({ externalInputResolver })`。
 *
 * 取不回来时**抛错**而不是返回空对象 —— 让任务失败远好过让 agent 拿着空输入跑。
 * 抛出的是普通 Error（可重试），因为多半是网络或签名过期；
 * 真正不可恢复的情况（没配外置存储）由 `resolveInput` 抛终局错误。
 */
export function createExternalInputResolver(opts: ExternalPayloadOptions): ExternalInputResolver {
  const fetchImpl = requireFetch(opts.fetchImpl);
  return async (path: string): Promise<Record<string, unknown>> => {
    const loc = await getExternalStorageLocation({ ...opts, path, payloadType: 'TASK_INPUT' });
    // 第二跳是带签名的直链，不带 Conductor 的鉴权头
    const res = await fetchImpl(loc.uri);
    if (!res.ok) {
      throw new Error(`下载外置输入失败：HTTP ${res.status}（path=${path}）`);
    }
    const body = await res.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`外置输入不是一个对象（path=${path}），拿到的是 ${typeof body}`);
    }
    return body as Record<string, unknown>;
  };
}
