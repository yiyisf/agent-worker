/**
 * 单测用的最小装配。放在 core 内是为了让 core 的测试**不依赖任何 Agent SDK**（§11）。
 * 面向使用者的完整测试设施（引擎一致性套件等）在 @ca/testing。
 */
import type { AgentSpec, JsonValue } from './spec.js';
import type { BuiltAgent, EngineRunArgs, RunGateways } from './engine.js';
import type { AgentEvent } from './events.js';
import type { RunContext } from './context.js';

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function testContext(over: Partial<RunContext> = {}): RunContext {
  const startedAt = Date.now();
  return {
    runId: 'task-1',
    attempt: 0,
    startedAt,
    deadline: startedAt + 60_000,
    signal: new AbortController().signal,
    logger: silentLogger,
    budget: {
      usedInputTokens: 0,
      usedOutputTokens: 0,
      usedCostUsd: 0,
      elapsedMs: 0,
      remaining: () => Infinity,
    },
    secrets: { get: async () => undefined },
    emit: (_e: AgentEvent) => {},
    ...over,
  };
}

export type ScriptStep =
  | { call: 'model'; payload: JsonValue; response: JsonValue; usage?: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { call: 'tool'; name: string; input: JsonValue; run: (o: { idempotencyKey: string }) => Promise<JsonValue> };

export interface ScriptedAgentOptions {
  steps: ScriptStep[];
  /** 跑完 steps 后的收尾，默认把每步的返回值汇总成数组 */
  finish?: (outputs: JsonValue[]) => JsonValue;
  /** 记录实际发生的真实调用，用于断言「跑了几次」 */
  sideEffects?: string[];
}

export function scriptedAgent(opts: ScriptedAgentOptions): BuiltAgent {
  return {
    async run(args: EngineRunArgs): Promise<JsonValue> {
      const { model, tools }: RunGateways = args.gateways;
      const outputs: JsonValue[] = [];
      for (const step of opts.steps) {
        if (step.call === 'model') {
          const r = await model.guard(step.payload, async () => {
            opts.sideEffects?.push(`model:${JSON.stringify(step.payload)}`);
            return {
              result: step.response,
              usage: step.usage ?? { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
            };
          });
          outputs.push(r);
        } else {
          const r = await tools.guard(step.name, step.input, async (o) => {
            opts.sideEffects?.push(`tool:${step.name}`);
            return step.run(o);
          });
          outputs.push(r);
        }
      }
      return opts.finish ? opts.finish(outputs) : outputs;
    },
  };
}

export function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { name: 'test', engine: 'test/scripted', ...over };
}
