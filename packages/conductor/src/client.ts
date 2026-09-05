/** Conductor REST 客户端契约，见 docs/architecture.md §6.1 与 ADR-0002。占位：仅声明契约。 */

export type TaskStatus =
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'FAILED_WITH_TERMINAL_ERROR';

export interface ConductorTask {
  taskId: string;
  taskType: string;
  taskDefName: string;
  referenceTaskName: string;
  workflowInstanceId: string;
  workflowType: string;
  correlationId?: string;
  retryCount: number;
  responseTimeoutSeconds: number;
  inputData: Record<string, unknown>;
  externalInputPayloadStoragePath?: string;
}

export interface TaskResult {
  workflowInstanceId: string;
  taskId: string;
  status: TaskStatus;
  outputData?: Record<string, unknown>;
  reasonForIncompletion?: string;
  callbackAfterSeconds?: number;
  logs?: Array<{ log: string; createdTime: number }>;
  externalOutputPayloadStoragePath?: string;
}

export interface TaskDef {
  name: string;
  retryCount: number;
  retryLogic: 'FIXED' | 'EXPONENTIAL_BACKOFF';
  retryDelaySeconds: number;
  timeoutSeconds: number;
  responseTimeoutSeconds: number;
  timeoutPolicy: 'RETRY' | 'TIME_OUT_WF' | 'ALERT_ONLY';
  concurrentExecLimit?: number;
  rateLimitPerFrequency?: number;
  rateLimitFrequencyInSeconds?: number;
}

export type WorkflowStatus =
  | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'TERMINATED' | 'PAUSED';

/**
 * 只覆盖 6 个长期稳定的端点；FakeConductorServer（@ca/testing）实现同一接口。
 */
export interface ConductorClient {
  /** GET /api/tasks/poll/batch/{taskType} */
  batchPoll(args: {
    taskType: string;
    workerId: string;
    domain?: string;
    count: number;
    timeoutMs: number;
  }): Promise<ConductorTask[]>;

  /** POST /api/tasks */
  updateTask(result: TaskResult): Promise<void>;

  /** POST /api/tasks/{taskId}/log */
  appendTaskLog(taskId: string, log: string): Promise<void>;

  /** GET /api/workflow/{workflowId}?includeTasks=false */
  getWorkflowStatus(workflowId: string): Promise<WorkflowStatus>;

  /** POST /api/metadata/taskdefs */
  registerTaskDefs(defs: TaskDef[]): Promise<void>;

  /** POST /api/workflow/{name} */
  startWorkflow(args: {
    name: string;
    version?: number;
    input: Record<string, unknown>;
    correlationId?: string;
  }): Promise<string>;
}

/** 鉴权在 OSS 与 Orkes 之间存在差异，收敛到这里 */
export type AuthStrategy =
  | { kind: 'none' }
  | { kind: 'basic'; username: string; password: string }
  | { kind: 'orkes-key'; keyId: string; keySecret: string };

export interface ConductorClientOptions {
  baseUrl: string;
  auth?: AuthStrategy;
  requestTimeoutMs?: number;
}
