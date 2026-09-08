/**
 * 大输入取回。核心断言只有一条：**取不回来就抛，绝不返回空对象** ——
 * 让任务失败远好过让 agent 拿着空输入烧一遍 token。
 */
import { describe, expect, it } from 'vitest';
import { createExternalInputResolver, getExternalStorageLocation, type FetchLike } from './external-payload.js';

function fakeFetch(routes: Record<string, { ok?: boolean; status?: number; body?: unknown; text?: string }>): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    const r = key ? routes[key]! : { ok: false, status: 404 };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.text ?? '',
      json: async () => r.body ?? {},
    };
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

const LOC = 'http://c/api/tasks/externalstoragelocation';
const BLOB = 'https://s3.example/signed';

describe('createExternalInputResolver', () => {
  it('两跳取回：先问 Conductor 要地址，再去下载', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [LOC]: { body: { uri: BLOB, path: 'task/input/abc.json' } },
      [BLOB]: { body: { question: '很长的输入', doc: 'x'.repeat(100) } },
    });
    const resolve = createExternalInputResolver({ serverUrl: 'http://c/api', fetchImpl });
    const input = await resolve('task/input/abc.json');

    expect(input).toEqual({ question: '很长的输入', doc: 'x'.repeat(100) });
    expect(calls[0]).toContain('operation=READ');
    expect(calls[0]).toContain('payloadType=TASK_INPUT');
    expect(calls[0]).toContain('path=task%2Finput%2Fabc.json');
    // 第二跳是带签名的直链，单独一次请求
    expect(calls[1]).toBe(BLOB);
  });

  it('第一跳失败 → 抛错，不返回空对象', async () => {
    const { fetchImpl } = fakeFetch({ [LOC]: { ok: false, status: 500, text: 'no storage configured' } });
    const resolve = createExternalInputResolver({ serverUrl: 'http://c/api', fetchImpl });
    await expect(resolve('p')).rejects.toThrow(/500.*no storage configured/);
  });

  it('响应里没有 uri → 抛错', async () => {
    const { fetchImpl } = fakeFetch({ [LOC]: { body: { path: 'p' } } });
    const resolve = createExternalInputResolver({ serverUrl: 'http://c/api', fetchImpl });
    await expect(resolve('p')).rejects.toThrow(/没有 uri/);
  });

  it('第二跳失败（签名过期等）→ 抛错', async () => {
    const { fetchImpl } = fakeFetch({
      [LOC]: { body: { uri: BLOB, path: 'p' } },
      [BLOB]: { ok: false, status: 403 },
    });
    const resolve = createExternalInputResolver({ serverUrl: 'http://c/api', fetchImpl });
    await expect(resolve('p')).rejects.toThrow(/403/);
  });

  it('下回来的不是对象 → 抛错，不硬塞给 agent', async () => {
    const { fetchImpl } = fakeFetch({
      [LOC]: { body: { uri: BLOB, path: 'p' } },
      [BLOB]: { body: ['a', 'b'] },
    });
    const resolve = createExternalInputResolver({ serverUrl: 'http://c/api', fetchImpl });
    await expect(resolve('p')).rejects.toThrow(/不是一个对象/);
  });

  it('第一跳带鉴权头，第二跳不带（那是签名直链）', async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers);
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => (url.startsWith(LOC) ? { uri: BLOB, path: 'p' } : { a: 1 }),
      };
    }) as unknown as FetchLike;

    const resolve = createExternalInputResolver({
      serverUrl: 'http://c/api',
      headers: { 'X-Authorization': 'tok' },
      fetchImpl,
    });
    await resolve('p');
    expect(seen[0]).toEqual({ 'X-Authorization': 'tok' });
    expect(seen[1]).toBeUndefined();
  });
});

describe('getExternalStorageLocation', () => {
  it('TASK_OUTPUT 也能取（读回外置的结果）', async () => {
    const { fetchImpl, calls } = fakeFetch({ [LOC]: { body: { uri: BLOB, path: 'p' } } });
    const loc = await getExternalStorageLocation({
      serverUrl: 'http://c/api',
      fetchImpl,
      path: 'p',
      payloadType: 'TASK_OUTPUT',
    });
    expect(loc.uri).toBe(BLOB);
    expect(calls[0]).toContain('payloadType=TASK_OUTPUT');
  });
});
