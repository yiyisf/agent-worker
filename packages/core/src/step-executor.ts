/**
 * 把「执行一步」抽象出来，为白盒模式（路线图 M5）留口，见 docs/architecture.md §5.4。
 * v1 只有 InProcessStepExecutor；未来的 ConductorStepExecutor 把 step 下沉为 Conductor task，
 * 核心状态机与 journal 结构不变。占位：仅声明契约。
 */
import type { ModelRequest, ModelResponse } from './model.js';
import type { RunContext } from './context.js';
import type { Tool } from './tool.js';

export interface StepExecutor {
  runModelStep(req: ModelRequest, stepId: string, ctx: RunContext): Promise<ModelResponse>;
  runToolStep(tool: Tool, input: unknown, stepId: string, ctx: RunContext): Promise<unknown>;
}
