import { describe, expect, it, vi } from 'vitest';
import { normalizeServerUrl, resolveHeaders, resolveServerUrl } from '../src/connection.js';
import { ConductorHttpError, MetadataApi } from '../src/metadata/api.js';
import { assertNameCn } from '../src/metadata/types.js';
import { deriveTaskDef } from '../src/taskdef.js';
import { spec } from './fixtures.js';

describe('assertNameCn', () => {
  it('缺失或空白时抛错', () => {
    expect(() => assertNameCn('WorkflowDef', { name: 'wf' })).toThrow(/WorkflowDef wf 缺少 nameCn/);
    expect(() => assertNameCn('TaskDef', { name: 't', nameCn: '' })).toThrow();
  });
  it('合法时通过', () => {
    expect(() => assertNameCn('TaskDef', { name: 't', nameCn: '任务' })).not.toThrow();
  });
});

describe('connection', () => {
  it('去掉末尾斜杠，拒绝缺少协议的地址', () => {
    expect(normalizeServerUrl('http://h:8080/api/')).toBe('http://h:8080/api');
    expect(() => normalizeServerUrl('h:8080/api')).toThrow();
  });

  it('显式配置 > CONDUCTOR_SERVER_URL > 默认值', () => {
    expect(resolveServerUrl({ serverUrl: 'http://a/api' }, { CONDUCTOR_SERVER_URL: 'http://b/api' })).toBe('http://a/api');
    expect(resolveServerUrl({}, { CONDUCTOR_SERVER_URL: 'http://b/api' })).toBe('http://b/api');
    expect(resolveServerUrl({}, {})).toBe('http://localhost:8080/api');
  });

  it('tokenProvider 生成 Bearer 头并与固定 header 合并', async () => {
    expect(await resolveHeaders({ headers: { 'X-A': '1' }, tokenProvider: async () => 't0k' })).toEqual({
      'X-A': '1',
      Authorization: 'Bearer t0k',
    });
  });
});

function mockFetch(status: number, body = '') {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body || null, { status }));
}

describe('MetadataApi', () => {
  const def = deriveTaskDef(spec());

  it('注册 TaskDef 时原样提交 nameCn 并带鉴权头', async () => {
    const fetch = mockFetch(204);
    const api = new MetadataApi({ serverUrl: 'http://h/api', tokenProvider: async () => 'tok', fetch });
    await api.registerTaskDefs([def]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://h/api/metadata/taskdefs');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))[0].nameCn).toBe('文档摘要 Agent');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('提交前校验 nameCn，可关闭', async () => {
    const fetch = mockFetch(204);
    const { nameCn: _, ...noName } = def;
    await expect(new MetadataApi({ serverUrl: 'http://h/api', fetch }).registerTaskDefs([noName])).rejects.toThrow(/nameCn/);
    expect(fetch).not.toHaveBeenCalled();
    await new MetadataApi({ serverUrl: 'http://h/api', fetch, requireNameCn: false }).registerTaskDefs([noName]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('WorkflowDef 走 PUT /metadata/workflow', async () => {
    const fetch = mockFetch(200);
    await new MetadataApi({ serverUrl: 'http://h/api', fetch }).upsertWorkflowDefs([
      { name: 'wf', nameCn: '流程', version: 1, schemaVersion: 2, ownerEmail: 'a@b.c', timeoutPolicy: 'ALERT_ONLY', timeoutSeconds: 0, tasks: [] },
    ]);
    expect(fetch.mock.calls[0]![1]?.method).toBe('PUT');
  });

  it('getTaskDef：404 返回 undefined，其他错误抛 ConductorHttpError', async () => {
    expect(await new MetadataApi({ serverUrl: 'http://h/api', fetch: mockFetch(404, 'nf') }).getTaskDef('x')).toBeUndefined();
    const api = new MetadataApi({ serverUrl: 'http://h/api', fetch: mockFetch(500, 'boom') });
    await expect(api.getTaskDef('x')).rejects.toBeInstanceOf(ConductorHttpError);
    const ok = new MetadataApi({ serverUrl: 'http://h/api', fetch: mockFetch(200, JSON.stringify(def)) });
    expect((await ok.getTaskDef(def.name))?.nameCn).toBe('文档摘要 Agent');
  });
});
