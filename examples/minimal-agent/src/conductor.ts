/**
 * 与 Conductor 的实际装配：注册元数据、拼 worker、起 TaskManager。
 *
 * poll 循环、并发、优雅停机全部交给官方 SDK（ADR-0006）——
 * 这个文件里没有一行是在重新实现那些东西。
 *
 * 用到的官方 API（均按 @io-orkes/conductor-javascript@4.0.0 的类型核实）：
 *   orkesConductorClient(config)              客户端
 *   MetadataClient.registerTask(taskDef)      注册 TaskDef
 *   WorkflowExecutor.registerWorkflow/startWorkflow/getWorkflow
 *   TaskClient.addTaskLog / getTaskLogs       进展的尽力而为通道
 *   TaskManager(client, workers, config)      poll 循环
 */
import { Redis } from 'ioredis';
import {
  MetadataClient,
  TaskClient,
  TaskManager,
  WorkflowExecutor,
  orkesConductorClient,
} from '@io-orkes/conductor-javascript';
import { RedisRunRegistry, type RedisLike } from '@ca/memory';
import { MemoryRunRegistry, type RunRegistry } from '@ca/core';
import { createAgentWorker, createCancellationWatcher, deriveTaskDef } from '@ca/conductor';
import type { AgentWorker, UpdateTaskFn } from '@ca/conductor';
import { TASK_TYPE, WORKFLOW_NAME, buildEngine, orderAgentSpec } from './agent.js';

export const CONDUCTOR_URL = process.env.CONDUCTOR_SERVER_URL ?? 'http://localhost:8080/api';
export const REDIS_URL = process.env.CA_TEST_REDIS_URL ?? 'redis://127.0.0.1:6380';

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
      // inputData 原样就是 agent 的输入，没有保留键、没有 __ca 命名空间（§6.5）
      inputParameters: { question: '${workflow.input.question}' },
    },
  ],
  outputParameters: {
    answer: '${agent_ref.output.result.text}',
    // 进展的权威通道就在 outputData 里，工作流可以直接消费（§10.4）
    progress: '${agent_ref.output.progress}',
    usage: '${agent_ref.output.usage}',
    runId: '${agent_ref.output.runId}',
  },
};

export async function registerMetadata(): Promise<void> {
  const client = await conductorClient();
  await new MetadataClient(client).registerTask(deriveTaskDef(orderAgentSpec) as never);
  await new WorkflowExecutor(client).registerWorkflow(true, workflowDef as never);
}

/**
 * 主动回执：后台运行结束时直接把任务推向终态，不等下一次 callback（§5.2）。
 *
 * 这里用裸 REST 而不是 TaskClient.updateTaskResult，只因为后者按
 * (workflowId, taskRefName) 定位任务，而我们要的是**精确到 taskId**：
 * 万一这中间任务已被重试，按 refName 更新会打到新的那一个。
 */
export function makeUpdateTask(): UpdateTaskFn {
  return async ({ taskId, workflowInstanceId, status, outputData, reasonForIncompletion }) => {
    const res = await fetch(`${CONDUCTOR_URL}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId,
        workflowInstanceId,
        status,
        outputData,
        ...(reasonForIncompletion ? { reasonForIncompletion } : {}),
      }),
    });
    if (!res.ok) throw new Error(`updateTask 失败：HTTP ${res.status} ${await res.text()}`);
  };
}

export interface Wiring extends AgentWorker {
  redis?: Redis;
  close: () => Promise<void>;
}

/**
 * 完整装配。
 *
 * 注册表：连得上 Redis 就用共享实现，否则退回单进程内存实现。
 * 这不是可选优化 —— 多 worker 实例部署时 Conductor **不保证** callback 回到同一个进程，
 * 内存注册表会让每个实例各跑一遍。
 */
export async function buildWiring(): Promise<Wiring> {
  const client = await conductorClient();
  const engine = await buildEngine();
  const executor = new WorkflowExecutor(client);
  const tasks = new TaskClient(client);

  let redis: Redis | undefined;
  let registry: RunRegistry = new MemoryRunRegistry();
  try {
    const r = new Redis(REDIS_URL, { lazyConnect: true, retryStrategy: () => null });
    await r.connect();
    redis = r;
    registry = new RedisRunRegistry({ client: r as unknown as RedisLike, prefix: 'ca-demo' });
  } catch {
    console.warn(`   （连不上 Redis(${REDIS_URL})，退回单进程内存注册表 —— 仅适用于单实例）`);
  }

  const { isWorkflowCancelled } = createCancellationWatcher({
    getStatus: async (id) => {
      const wf = (await executor.getWorkflow(id, false)) as { status?: string };
      return wf.status ?? 'RUNNING';
    },
  });

  const wired = createAgentWorker({
    specs: [orderAgentSpec],
    engines: [engine],
    registry,
    logger: console,
    isWorkflowCancelled,
    updateTask: makeUpdateTask(),
    // 进展的尽力而为通道（§10.4）。写失败不影响主流程 —— 权威通道是 outputData.progress
    taskLogSink: (task) =>
      task.taskId
        ? {
            addLogs: async (lines) => {
              for (const line of lines) await tasks.addTaskLog(task.taskId!, line);
            },
          }
        : undefined,
    progress: { intervalMs: 2_000 },
  });

  return {
    ...wired,
    ...(redis ? { redis } : {}),
    close: async () => {
      await wired.host.drain();
      await redis?.quit();
    },
  };
}

/** 起 poll 循环。TaskManager 是官方的，我们只把编译好的 worker 交给它 */
export async function startPolling(wiring: Wiring): Promise<TaskManager> {
  const client = await conductorClient();
  const manager = new TaskManager(client, wiring.workers as never, {
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
  tasks?: { taskId?: string; status?: string; pollCount?: number; outputData?: Record<string, unknown> }[];
}> {
  const client = await conductorClient();
  return (await new WorkflowExecutor(client).getWorkflow(workflowId, true)) as never;
}

export async function getTaskLogs(taskId: string): Promise<{ log?: string }[]> {
  const client = await conductorClient();
  return (await new TaskClient(client).getTaskLogs(taskId)) as never;
}
