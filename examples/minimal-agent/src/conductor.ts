/**
 * 与 Conductor 的实际装配：注册元数据、拼 worker、起 TaskManager。
 *
 * poll 循环、并发、优雅停机全部交给官方 SDK（ADR-0006）——
 * 这个文件里没有一行是在重新实现那些东西。
 *
 * 用到的官方 API（均按 @io-orkes/conductor-javascript@4.0.0 的类型核实）：
 *   orkesConductorClient(config)              客户端
 *   MetadataClient.registerTask(taskDef)      注册 TaskDef
 *   WorkflowExecutor.registerWorkflow(o, def) 注册工作流
 *   WorkflowExecutor.startWorkflow(req)       触发一次运行
 *   WorkflowExecutor.getWorkflow(id, bool)    查状态（取消检测 + 断言）
 *   TaskClient.addTaskLog(taskId, message)    进展的尽力而为通道
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
import { RedisStateStore, type RedisLike } from '@ca/memory';
import { createAgentWorker, createCancellationWatcher, deriveTaskDef } from '@ca/conductor';
import type { CompiledWorker } from '@ca/conductor';
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
      inputParameters: { input: '${workflow.input.question}' },
    },
  ],
  outputParameters: {
    answer: '${agent_ref.output.result.text}',
    // 进展的权威通道就在 outputData 里，工作流可以直接消费（§10.4）
    progress: '${agent_ref.output.progress}',
    usage: '${agent_ref.output.usage}',
    slices: '${agent_ref.output.slices}',
  },
};

/**
 * TaskDef 由 limits 推导，避免「代码里 2 分钟、TaskDef 里 60 秒」这类超时错配（§6.6）。
 * 这里能直接看到 30s 下限的效果：spec 的 sliceMs 是 1s，×3 = 3s，被夹到 30s。
 */
export async function registerMetadata(): Promise<void> {
  const client = await conductorClient();
  const metadata = new MetadataClient(client);
  const executor = new WorkflowExecutor(client);

  const taskDef = deriveTaskDef(orderAgentSpec);
  await metadata.registerTask(taskDef as never);
  await executor.registerWorkflow(true, workflowDef as never);
}

export interface Wiring {
  workers: CompiledWorker[];
  redis: Redis;
  close: () => Promise<void>;
}

/** 完整装配：worker + 进展两通道 + 取消检测 */
export async function buildWiring(): Promise<Wiring> {
  const client = await conductorClient();
  const engine = await buildEngine();
  const executor = new WorkflowExecutor(client);
  const tasks = new TaskClient(client);

  const redis = new Redis(REDIS_URL, { lazyConnect: true });
  await redis.connect();

  const { isWorkflowCancelled } = createCancellationWatcher({
    getStatus: async (id) => {
      const wf = (await executor.getWorkflow(id, false)) as { status?: string };
      return wf.status ?? 'RUNNING';
    },
  });

  const { workers } = createAgentWorker({
    specs: [orderAgentSpec],
    engines: [engine as never],
    stateStore: new RedisStateStore({ client: redis as unknown as RedisLike, prefix: 'ca-demo' }),
    logger: console,
    isWorkflowCancelled,
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
    workers,
    redis,
    close: async () => {
      await redis.quit();
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
  const executor = new WorkflowExecutor(client);
  return executor.startWorkflow({
    name: WORKFLOW_NAME,
    version: 1,
    input: { question },
  } as never);
}

export async function getWorkflow(workflowId: string): Promise<{
  status?: string;
  output?: Record<string, unknown>;
  tasks?: { taskId?: string; status?: string; callbackAfterSeconds?: number }[];
}> {
  const client = await conductorClient();
  const executor = new WorkflowExecutor(client);
  return (await executor.getWorkflow(workflowId, true)) as never;
}

export async function getTaskLogs(taskId: string): Promise<{ log?: string }[]> {
  const client = await conductorClient();
  return (await new TaskClient(client).getTaskLogs(taskId)) as never;
}
