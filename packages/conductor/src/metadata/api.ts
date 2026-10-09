import { DEFAULT_REQUEST_TIMEOUT_MS, resolveHeaders, resolveServerUrl } from '../connection.js';
import type { ConnectionOptions } from '../types.js';
import { assertNameCn, type CasTaskDef, type TaskDefInput, type WorkflowDefInput } from './types.js';

export class ConductorHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} -> HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'ConductorHttpError';
  }
}

export interface MetadataApiOptions extends ConnectionOptions {
  /** 默认 true（目标部署要求）；对接未定制的 OSS 部署时设为 false（ADR-0023） */
  requireNameCn?: boolean;
  /** 测试注入 */
  fetch?: typeof fetch;
}

/**
 * 元数据注册直接走 REST，见 ADR-0023。移植自 Claude Projects 版 ca-worker。
 * 保证 nameCn 等定制字段原样提交，不受官方 SDK 类型或序列化影响。
 * 若验证确认 SDK 4.0.0 会保留 nameCn，可改为委托 SDK（architecture.md §15.4）。
 */
export class MetadataApi {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: MetadataApiOptions = {}) {
    this.baseUrl = resolveServerUrl(options);
    this.fetchFn = options.fetch ?? fetch;
  }

  async registerTaskDefs(defs: TaskDefInput[]): Promise<void> {
    this.check('TaskDef', defs);
    await this.request('POST', '/metadata/taskdefs', defs);
  }

  async upsertWorkflowDefs(defs: WorkflowDefInput[]): Promise<void> {
    this.check('WorkflowDef', defs);
    await this.request('PUT', '/metadata/workflow', defs);
  }

  async getTaskDef(name: string): Promise<CasTaskDef | undefined> {
    try {
      return await this.request<CasTaskDef>('GET', `/metadata/taskdefs/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e instanceof ConductorHttpError && e.status === 404) return undefined;
      throw e;
    }
  }

  private check(kind: 'TaskDef' | 'WorkflowDef', defs: Array<{ name: string; nameCn?: unknown }>): void {
    if (this.options.requireNameCn !== false) defs.forEach((d) => assertNameCn(kind, d));
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(await resolveHeaders(this.options)),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new ConductorHttpError(method, path, res.status, text);
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
