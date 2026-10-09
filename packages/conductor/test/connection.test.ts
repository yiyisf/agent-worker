import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConductorClient } from '../src/connection.js';

/** 用本地 HTTP 服务验证经官方 SDK 发出的请求确实带上了网关鉴权头 */
describe('createConductorClient', () => {
  let server: Server;
  let baseUrl: string;
  const seen: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 't', nameCn: '任务' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('tokenProvider 与 headers 经 customFetch 注入官方 SDK 的请求', async () => {
    let calls = 0;
    const client = await createConductorClient(
      { serverUrl: baseUrl, headers: { 'X-Tenant': 'acme' }, tokenProvider: async () => `tok${++calls}` },
      {},
    );
    seen.length = 0;
    await client.metadataResource.getTaskDef('t');
    expect(seen.at(-1)?.authorization).toBe('Bearer tok1');
    expect(seen.at(-1)?.['x-tenant']).toBe('acme');
  });
});
