/**
 * 与 Conductor 的实际装配：注册元数据、拼 worker、起 TaskManager。
 *
 * poll 循环、并发、优雅停机、**租约心跳**全部交给官方 SDK（ADR-0006 / ADR-0022）——
 * 这个文件里没有一行是在重新实现那些东西，也**没有任何外部中间件**。
 *
 * 用到的官方 API（均按 @io-orkes/conductor-javascript@4.0.0 的类型核实）：
 *   orkesConductorClient(config)              客户端
 *   MetadataClient.registerTask(taskDef)      注册 TaskDef
 *   WorkflowExecutor.registerWorkflow/startWorkflow/getWorkflow
 *   TaskClient.addTaskLog / getTaskLogs       进展（运行中唯一可见的通道）
 *   TaskManager(client, workers, config)      poll 循环 + LeaseTracker 心跳
 */
import {
  MetadataClient,
  TaskClient,
  TaskManager,
  WorkflowExecutor,
  orkesConductorClient,
} from '@io-orkes/conductor-javascript';
import {
  createAgentWorker,
  createCancellationWatcher,
  createExternalInputResolver,
  deriveTaskDef,
  httpPreflightSource,
  preflight,
} from '@ca/conductor';
import type { AgentWorker, PreflightReport } from '@ca/conductor';
import { TASK_TYPE, WORKFLOW_NAME, buildEngine, orderAgentSpec } from './agent.js';

export const CONDUCTOR_URL = process.env.CONDUCTOR_SERVER_URL ?? 'http://localhost:8080/api';

// 显式标注返回类型：客户端类型里带了 undici 的内部类型，推断出来不可移植
export type ConductorClientInstance = Awaited<ReturnType<typeof orkesConductorClient>>;

export async function conductorClient(): Promise<ConductorClientInstance> {
  return orkesConductorClient({ serverUrl: CONDUCTOR_URL });
}

/** 只有一个 SIMPLE 任务的工作流；Agent 就挂在这个任务上 */
export const workflowDef = {
  name: WORKFLOW_NAME,
  version: 1,
  schemaVersion: 2,
  timeoutSeconds: 0,
  tasks: [
    {
      name: TASK_TYPE,
      taskReferenceName: 'agent_ref',
      type: 'SIMPLE',
      // inputData 原样就是 agent 的输入，没有保留键、没有命名空间（§6.5）
      inputParameters: { question: '${workflow.input.question}' },
    },
  ],
  outputParameters: {
    answer: '${agent_ref.output.result.text}',
    progress: '${agent_ref.output.progress}',
    usage: '${agent_ref.output.usage}',
    taskId: '${agent_ref.output.taskId}',
  },
};

export async function registerMetadata(): Promise<void> {
  const client = await conductorClient();
  await new MetadataClient(client).registerTask(deriveTaskDef(orderAgentSpec) as never);
  await new WorkflowExecutor(client).registerWorkflow(true, workflowDef as never);
}

/**
 * 启动自检（§6.8）。放在注册之后、起 worker 之前。
 *
 * 它挡的是两类**静默失效**：服务端 < 3.10.7（没有 extendLease，长任务必被判超时），
 * 以及线上 TaskDef 的 responseTimeoutSeconds 被调到 1.25 以下（官方心跳会跳过不发）。
 * 这两种情况不检查的话，线上表现都是"agent 莫名其妙超时"，很难查。
 */
export async function runPreflight(strict = true): Promise<PreflightReport> {
  return preflight({
    taskDefs: [deriveTaskDef(orderAgentSpec)],
    source: httpPreflightSource({ serverUrl: CONDUCTOR_URL }),
    logger: console,
    // verify 脚本传 false：负向验证时要把问题**记成一条红色检查项**，
    // 而不是抛出去变成「脚本自己崩了」
    strict,
  });
}

export interface Wiring extends AgentWorker {
  close: () => Promise<void>;
}

/** 完整装配。**没有 Redis、没有任何外部存储** —— agent 状态全程在 worker 进程内。 */
export async function buildWiring(): Promise<Wiring> {
  const client = await conductorClient();
  const engine = await buildEngine();
  const executor = new WorkflowExecutor(client);
  const tasks = new TaskClient(client);

  const { isWorkflowCancelled } = createCancellationWatcher({
    getStatus: async (id) => {
      const wf = (await executor.getWorkflow(id, false)) as { status?: string };
      return wf.status ?? 'RUNNING';
    },
  });

  const wired = createAgentWorker({
    specs: [orderAgentSpec],
    engines: [engine],
    logger: console,
    isWorkflowCancelled,
    // 大输入（> 3072 KB）会被服务端外置，inputData 变空 —— 必须显式取回（§6.5）
    externalInputResolver: createExternalInputResolver({ serverUrl: CONDUCTOR_URL }),
    /**
     * 进展的**运行中**通道（§10.4）。extendLease 模式下 outputData 只在结束时写一次，
     * 所以这是运行途中唯一能看见进度的地方。写失败不影响主流程。
     */
    taskLogSink: (task) =>
      task.taskId
        ? {
            addLogs: async (lines) => {
              for (const line of lines) await tasks.addTaskLog(task.taskId!, line);
            },
            // 一次性实测：写完读回来是空的就说明该部署没启索引，自动关闭通道并告警一次。
            // 读配置是靠不住的 —— /admin/config 返回的是 System.getProperties()。
            readLogs: () => tasks.getTaskLogs(task.taskId!) as Promise<unknown[]>,
          }
        : undefined,
    progress: { intervalMs: 2_000 },
  });

  return { ...wired, close: async () => {} };
}

/**
 * 起 poll 循环。TaskManager 是官方的，我们只把编译好的 worker 交给它 ——
 * `leaseExtendEnabled: true` 已经写在 worker 上，LeaseTracker 会自动接管心跳。
 *
 * ⚠️ concurrency = **同时最多跑几个 agent**：一个长跑 agent 会占住一个槽的全程。
 */
export async function startPolling(_wiring: Wiring): Promise<TaskManager> {
  const client = await conductorClient();
  const manager = new TaskManager(client, _wiring.workers as never, {
    options: { pollInterval: 200, concurrency: 2 },
  });
  manager.startPolling();
  return manager;
}

export async function startRun(question: string): Promise<string> {
  const client = await conductorClient();
  return new WorkflowExecutor(client).startWorkflow({
    name: WORKFLOW_NAME,
    version: 1,
    input: { question },
  } as never);
}

export async function getWorkflow(workflowId: string): Promise<{
  status?: string;
  output?: Record<string, unknown>;
  tasks?: {
    taskId?: string;
    status?: string;
    pollCount?: number;
    retryCount?: number;
    startTime?: number;
    endTime?: number;
  }[];
}> {
  const client = await conductorClient();
  return (await new WorkflowExecutor(client).getWorkflow(workflowId, true)) as never;
}

export async function getTaskLogs(taskId: string): Promise<{ log?: string }[]> {
  const client = await conductorClient();
  return (await new TaskClient(client).getTaskLogs(taskId)) as never;
}
