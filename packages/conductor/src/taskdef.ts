/**
 * 由 AgentDefinition.limits 推导 Conductor TaskDef，见 docs/architecture.md §6.6。
 * 目的：消除「代码里 5 分钟、TaskDef 里 60 秒」这类超时错配。占位：仅声明契约。
 */
import type { AgentDefinition } from '@ca/core';
import type { TaskDef } from './client.js';

export declare function deriveTaskDef(def: AgentDefinition): TaskDef;

export interface TaskDefDrift {
  name: string;
  field: string;
  local: unknown;
  remote: unknown;
}

/** 启动时校验线上 TaskDef 与本地定义是否漂移；默认告警不阻塞 */
export declare function diffTaskDefs(local: TaskDef[], remote: TaskDef[]): TaskDefDrift[];
