/**
 * 单测用的最小装配。放在 core 内是为了让 core 的测试**不依赖任何 Agent SDK**（§11）。
 * 面向使用者的完整测试设施（引擎一致性套件等）在 @ca/testing。
 */
import type { AgentSpec, JsonValue } from './spec.js';
import type { BuiltAgent, EngineRunArgs, EngineTurn, RunGateways } from './engine.js';
import type { AgentEvent } from './events.js';
import type { RunContext } from './context.js';

export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function makeContext(over: Partial<RunContext> = {}): RunContext & { events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const now = Date.now();
  const ctx = {
    runKey: 'wf-1:agent_ref:0',
    runId: 'run-1',
    attempt: 0,
    sliceIndex: 0,
    startedAt: now,
    deadline: now + 300_000,
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
    emit(e: AgentEvent) {
      events.push(e);
    },
    events,
    ...over,
  } as RunContext & { events: AgentEvent[] };
  return ctx;
}

/** 用一个脚本化的「循环」冒充引擎：每一步都必须经过受管入口，正如真实引擎的义务 */
export type ScriptStep =
  | { call: 'model'; payload: JsonValue; response: JsonValue; usage?: { inputTokens: number; outputTokens: number; costUsd?: number } }
  | { call: 'tool'; name: string; input: JsonValue; run: (opts: { idempotencyKey: string }) => Promise<JsonValue> };

export interface ScriptedAgentOptions {
  steps: ScriptStep[];
  /** 跑完 steps 后的收尾动作，默认 done */
  finish?: (state: JsonValue) => EngineTurn<JsonValue>;
  /** 记录实际发生的真实调用（未被 journal 短路的），用于断言"没有重复付费/重复副作用" */
  sideEffects?: string[];
}

export function scriptedAgent(opts: ScriptedAgentOptions): BuiltAgent<JsonValue> {
  return {
    async run(args: EngineRunArgs<JsonValue>): Promise<EngineTurn<JsonValue>> {
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
      return opts.finish ? opts.finish(outputs) : { kind: 'done', output: outputs };
    },
  };
}

export function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { name: 'test', engine: 'test/scripted', ...over };
}
