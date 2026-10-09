/**
 * 直接调用 Conductor REST API 的最小客户端。
 * 验证脚本刻意不依赖官方 JS SDK：要测的是服务端行为本身，避免 SDK 版本差异干扰结论。
 */
export interface HttpResult<T = unknown> {
  status: number;
  data: T | undefined;
  text: string;
}

export interface Task {
  taskId: string;
  taskType: string;
  status: string;
  referenceTaskName: string;
  workflowInstanceId: string;
  retryCount?: number;
  retriedTaskId?: string;
  pollCount?: number;
  workerId?: string;
  reasonForIncompletion?: string;
  outputData?: Record<string, unknown>;
  externalOutputPayloadStoragePath?: string;
  callbackAfterSeconds?: number;
}

export interface Workflow {
  workflowId: string;
  status: string;
  reasonForIncompletion?: string;
  tasks?: Task[];
}

export type TaskResultStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'FAILED_WITH_TERMINAL_ERROR';

export interface TaskResult {
  workflowInstanceId: string;
  taskId: string;
  workerId?: string;
  status: TaskResultStatus;
  outputData?: Record<string, unknown>;
  callbackAfterSeconds?: number;
  /** ≥ 3.10.7：只重置 responseTimeout 计时器，不把任务放回队列（源码阅读结论，待本工具实测） */
  extendLease?: boolean;
  reasonForIncompletion?: string;
}

export class ConductorRest {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly headers: Record<string, string> = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get url(): string {
    return this.baseUrl;
  }

  async request<T>(method: string, path: string, body?: unknown, rawBody = false): Promise<HttpResult<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        ...this.headers,
      },
      body: body === undefined ? undefined : rawBody ? String(body) : JSON.stringify(body),
    });
    const text = await res.text();
    let data: T | undefined;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as unknown as T;
      }
    }
    return { status: res.status, data, text };
  }

  private async ok<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.request<T>(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${r.text.slice(0, 500)}`);
    return r.data as T;
  }

  registerTaskDefs(defs: object[]) {
    return this.ok<unknown>('POST', '/metadata/taskdefs', defs);
  }

  getTaskDef(name: string) {
    return this.request<Record<string, unknown>>('GET', `/metadata/taskdefs/${encodeURIComponent(name)}`);
  }

  deleteTaskDef(name: string) {
    return this.request('DELETE', `/metadata/taskdefs/${encodeURIComponent(name)}`);
  }

  upsertWorkflowDefs(defs: object[]) {
    return this.ok<unknown>('PUT', '/metadata/workflow', defs);
  }

  deleteWorkflowDef(name: string, version = 1) {
    return this.request('DELETE', `/metadata/workflow/${encodeURIComponent(name)}/${version}`);
  }

  async startWorkflow(name: string, input: Record<string, unknown> = {}, version = 1): Promise<string> {
    const r = await this.request<string>('POST', '/workflow', { name, version, input });
    if (r.status >= 300) throw new Error(`启动工作流 ${name} 失败 -> HTTP ${r.status}: ${r.text.slice(0, 500)}`);
    return r.text.replace(/"/g, '').trim();
  }

  /** 无任务时服务端返回 204 或空响应体 */
  async poll(taskType: string, workerId: string): Promise<Task | undefined> {
    const r = await this.request<Task>(
      'GET',
      `/tasks/poll/${encodeURIComponent(taskType)}?workerid=${encodeURIComponent(workerId)}`,
    );
    if (r.status === 204 || !r.text) return undefined;
    if (r.status >= 300) throw new Error(`poll ${taskType} -> HTTP ${r.status}: ${r.text.slice(0, 500)}`);
    return r.data;
  }

  updateTask(result: TaskResult) {
    return this.request<string>('POST', '/tasks', result);
  }

  getTask(taskId: string) {
    return this.ok<Task>('GET', `/tasks/${taskId}`);
  }

  getWorkflow(workflowId: string, includeTasks = true) {
    return this.ok<Workflow>('GET', `/workflow/${workflowId}?includeTasks=${includeTasks}`);
  }

  async terminate(workflowId: string, reason: string): Promise<void> {
    await this.request('DELETE', `/workflow/${workflowId}?reason=${encodeURIComponent(reason)}`);
  }

  /** 服务端以原始字符串接收日志内容 */
  addTaskLog(taskId: string, message: string) {
    return this.request('POST', `/tasks/${taskId}/log`, message, true);
  }

  getTaskLogs(taskId: string) {
    return this.request<Array<{ log: string }>>('GET', `/tasks/${taskId}/log`);
  }
}
