/**
 * 连接配置的解析与官方 SDK 客户端构造。移植自 Claude Projects 版 ca-worker（conductor/connection.ts、client.ts）。
 */
import { createConductorClient as createOfficialClient } from '@io-orkes/conductor-javascript';
import type { ConnectionOptions } from './types.js';

export type ConductorClient = Awaited<ReturnType<typeof createOfficialClient>>;

export const DEFAULT_SERVER_URL = 'http://localhost:8080/api';
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function normalizeServerUrl(serverUrl: string): string {
  const url = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error(`serverUrl 必须以 http:// 或 https:// 开头：${serverUrl}`);
  return url;
}

/** 显式配置 > CONDUCTOR_SERVER_URL > 默认值 */
export function resolveServerUrl(c: ConnectionOptions = {}, env: NodeJS.ProcessEnv = process.env): string {
  return normalizeServerUrl(c.serverUrl ?? env.CONDUCTOR_SERVER_URL ?? DEFAULT_SERVER_URL);
}

export async function resolveHeaders(c: ConnectionOptions = {}): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...c.headers };
  if (c.tokenProvider) headers.Authorization = `Bearer ${await c.tokenProvider()}`;
  return headers;
}

/**
 * 构造官方 SDK 4.0.0 客户端，供 TaskManager 轮询与上报使用。
 *
 * 网关鉴权（tokenProvider / headers）通过 createConductorClient 的第二个参数 customFetch 注入 ——
 * 这解决了 Projects 版 client.ts 中「4.0.0 如何注入自定义 header」的 TODO。
 * 代价：传入 customFetch 后官方 SDK 不再使用其内置的 HTTP/2 fetch；未配置网关鉴权时不传，保留默认行为。
 */
export async function createConductorClient(
  c: ConnectionOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConductorClient> {
  const authKey = c.authKey ?? env.CONDUCTOR_AUTH_KEY;
  const authSecret = c.authSecret ?? env.CONDUCTOR_AUTH_SECRET;
  const config = {
    serverUrl: resolveServerUrl(c, env),
    requestTimeoutMs: c.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    ...(authKey && authSecret ? { keyId: authKey, keySecret: authSecret } : {}),
  };
  if (!c.tokenProvider && !c.headers) return createOfficialClient(config);

  const fetchWithHeaders: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    for (const [k, v] of Object.entries(await resolveHeaders(c))) req.headers.set(k, v);
    return fetch(req);
  };
  return createOfficialClient(config, fetchWithHeaders);
}
