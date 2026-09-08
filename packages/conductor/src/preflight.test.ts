/**
 * 启动自检：设计里所有「启动时拒绝 / 启动时告警」的落地点。
 *
 * 断言的重点是**该拒的拒、该放的放** —— 尤其是那几个「不检查就会静默失效」的配置。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@ca/core';
import { httpPreflightSource, preflight, serverVersionOf, type PreflightSource } from './preflight.js';
import { deriveTaskDef } from './taskdef.js';
import type { DerivedTaskDef } from './taskdef.js';

const spec = { name: 'demo', engine: 'test/engine' } as const;
const local = deriveTaskDef(spec);

function sourceOf(over: Partial<PreflightSource> & { version?: string; remote?: Partial<DerivedTaskDef>[] } = {}): PreflightSource {
  return {
    fetchServerConfig: over.fetchServerConfig ?? (async () => ({ version: over.version ?? '3.21.21' })),
    fetchTaskDefs: over.fetchTaskDefs ?? (async () => over.remote ?? [local]),
  };
}

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('preflight', () => {
  it('一切正常时零问题零告警', async () => {
    const r = await preflight({ taskDefs: [local], source: sourceOf(), logger: silent });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.serverVersion).toBe('3.21.21');
    expect(r.extendLeaseSupported).toBe(true);
  });

  it('服务端 < 3.10.7 → 拒绝启动', async () => {
    await expect(
      preflight({ taskDefs: [local], source: sourceOf({ version: '3.10.6' }), logger: silent }),
    ).rejects.toThrow(/extendLease/);
  });

  it('拿不到版本号只告警，不阻塞 —— 私有构建可能没有 version 键', async () => {
    const r = await preflight({
      taskDefs: [local],
      source: sourceOf({ fetchServerConfig: async () => ({ 'java.version': '17' }) }),
      logger: silent,
    });
    expect(r.ok).toBe(true);
    expect(r.extendLeaseSupported).toBe('unknown');
    expect(r.warnings.join()).toMatch(/拿不到服务端版本号/);
  });

  it('/admin/config 读不通也只告警 —— 有的部署会把 admin 端点关掉', async () => {
    const r = await preflight({
      taskDefs: [local],
      source: sourceOf({
        fetchServerConfig: async () => {
          throw new Error('HTTP 403');
        },
      }),
      logger: silent,
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/403/);
  });

  it('线上 responseTimeoutSeconds 被调到 1.25 以下 → 拒绝启动（心跳会静默失效）', async () => {
    await expect(
      preflight({
        taskDefs: [local],
        source: sourceOf({ remote: [{ ...local, responseTimeoutSeconds: 1 }] }),
        logger: silent,
      }),
    ).rejects.toThrow(/静默跳过心跳/);
  });

  it('线上 responseTimeoutSeconds 只是被改大 → 告警不阻塞', async () => {
    const r = await preflight({
      taskDefs: [local],
      source: sourceOf({ remote: [{ ...local, responseTimeoutSeconds: 300 }] }),
      logger: silent,
    });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/responseTimeoutSeconds/);
  });

  it('线上 retryCount = 0 → 拒绝启动（worker 崩了任务不会被重新分配）', async () => {
    await expect(
      preflight({
        taskDefs: [local],
        source: sourceOf({ remote: [{ ...local, retryCount: 0 }] }),
        logger: silent,
      }),
    ).rejects.toThrow(/不会被重新分配/);
  });

  it('线上没有这个 TaskDef → 告警提示先注册', async () => {
    const r = await preflight({ taskDefs: [local], source: sourceOf({ remote: [] }), logger: silent });
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toMatch(/registerTask/);
  });

  it('strict=false 只收集报告不抛 —— 灰度期用', async () => {
    const r = await preflight({
      taskDefs: [local],
      source: sourceOf({ version: '3.10.6' }),
      logger: silent,
      strict: false,
    });
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
  });

  it('问题与告警都会经 logger 输出，运维看得见', async () => {
    const warn = vi.fn();
    const error = vi.fn();
    await preflight({
      taskDefs: [local],
      source: sourceOf({ version: '3.10.6', remote: [] }),
      logger: { debug() {}, info() {}, warn, error },
      strict: false,
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('serverVersionOf', () => {
  it('认得 version 键，且要求形似版本号', () => {
    expect(serverVersionOf({ version: '3.21.21' })).toBe('3.21.21');
    expect(serverVersionOf({ 'conductor.build.version': '3.22.3' })).toBe('3.22.3');
    expect(serverVersionOf({ version: 'unknown' })).toBeUndefined();
    expect(serverVersionOf({})).toBeUndefined();
  });
});

describe('httpPreflightSource', () => {
  it('打到正确的端点上，并带上鉴权头', async () => {
    const calls: { url: string; headers?: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, ...(init?.headers ? { headers: init.headers } : {}) });
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    }) as never;

    const src = httpPreflightSource({
      serverUrl: 'http://x/api/',
      headers: { 'X-Authorization': 'tok' },
      fetchImpl,
    });
    await src.fetchServerConfig();
    await src.fetchTaskDefs();

    expect(calls[0]!.url).toBe('http://x/api/admin/config');
    expect(calls[1]!.url).toBe('http://x/api/metadata/taskdefs');
    expect(calls[0]!.headers).toEqual({ 'X-Authorization': 'tok' });
  });

  it('非 2xx 抛错并带上响应体', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      text: async () => 'boom',
      json: async () => ({}),
    })) as never;
    const src = httpPreflightSource({ serverUrl: 'http://x/api', fetchImpl });
    await expect(src.fetchServerConfig()).rejects.toThrow(/503.*boom/);
  });
});
