/**
 * @ca/engine-ai-sdk —— 适配 Vercel AI SDK 的 ToolLoopAgent。
 * 见 docs/architecture.md §4.3、ADR-0011、ADR-0012、ADR-0019。
 *
 * 上游基线：**ai@^7.0.0**（ToolLoopAgent / V4 模型契约都是 v7 的能力，v5 没有）。
 *
 * 适配器的全部义务只有一条：**让模型调用与工具执行都经过受管入口**。
 * 除此之外的循环、上下文管理、停止条件、provider 生态，一律交给 AI SDK。
 *
 * 我们只依赖上游 3 个 API 面（ADR-0017 / §11），升级时只需盯这三处：
 *   1. wrapLanguageModel 中间件的 wrapGenerate
 *   2. 包装 tool({ execute })
 *   3. stopWhen 自定义停止条件
 */
import { ToolLoopAgent, isStepCount, wrapLanguageModel } from 'ai';
import type { LanguageModel, ModelMessage, StopCondition, ToolSet } from 'ai';
import { CaError } from '@ca/core';
import type {
  AgentEngine,
  AgentSpec,
  BuiltAgent,
  EngineBuildDeps,
  EngineCapabilities,
  EngineRunArgs,
  JsonValue,
  Usage,
} from '@ca/core';

export interface AiSdkEngineOptions {
  model: LanguageModel;
  tools?: ToolSet;
  system?: string;
  /**
   * 把 V4 的 usage 换算成成本。不提供则 costUsd 为 0，
   * 此时 limits.maxCostUsd 形同虚设 —— build 时会告警。
   */
  pricing?: (args: { modelId: string; inputTokens: number; outputTokens: number }) => number;
  /**
   * 自定义首轮消息。默认把 input 序列化成一条 user 消息。
   * 重试时 previousAttempt 是上一次 attempt 的 outputData（Conductor 原生携带），
   * 要不要参考它、怎么参考，是**业务判断**，所以交给调用方而不是由引擎猜。
   */
  buildMessages?: (args: { input: JsonValue; previousAttempt?: JsonValue }) => ModelMessage[];
}

export const AI_SDK_ENGINE_ID = 'ai-sdk/tool-loop';

export const aiSdkCapabilities: EngineCapabilities = {
  // wrapLanguageModel 拦得到每一次模型调用
  costVisibility: 'per-call',
  // 所有工具都是我们包装过的 tool({ execute })
  toolInterception: 'all',
  /**
   * M1 不做引擎级挂起。短等待直接在**工具内部 await**，长等待交给工作流的 HUMAN 任务
   * （见 §4.7）；引擎级的两段式审批留到 M5。
   */
  suspend: 'none',
  progress: 'step',
  streaming: true,
  structuredOutput: true,
};

/** V4 的 usage 是嵌套结构（inputTokens.total / outputTokens.total），不是扁平数字 */
function toCaUsage(
  usage: { inputTokens?: { total?: number }; outputTokens?: { total?: number } } | undefined,
  modelId: string,
  pricing: AiSdkEngineOptions['pricing'],
): Usage {
  const inputTokens = usage?.inputTokens?.total ?? 0;
  const outputTokens = usage?.outputTokens?.total ?? 0;
  return {
    inputTokens,
    outputTokens,
    costUsd: pricing ? pricing({ modelId, inputTokens, outputTokens }) : 0,
  };
}

/**
 * 模型请求里有不宜参与哈希的字段：abortSignal 是对象、headers 可能带每次不同的 trace id。
 * 留着它们会让幂等键在同样的调用上算出不同的值。
 */
function hashableParams(params: Record<string, unknown>): JsonValue {
  const { abortSignal: _a, headers: _h, ...rest } = params;
  return JSON.parse(JSON.stringify(rest)) as JsonValue;
}

function defaultMessages(input: JsonValue): ModelMessage[] {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return [{ role: 'user', content: text }];
}

export function createAiSdkEngine(opts: AiSdkEngineOptions): AgentEngine {
  return {
    id: AI_SDK_ENGINE_ID,
    // ADR-0017：只在暴露给领域包的形状破坏性变化时 +1，与上游 ai 的版本号无关
    contractVersion: 2,
    capabilities: aiSdkCapabilities,
    // ToolLoopAgent 没有内建工具，工具全部由我们声明，所以 toolInterception 才能是 'all'
    builtinTools: [],

    async build(_spec: AgentSpec, deps: EngineBuildDeps): Promise<BuiltAgent> {
      if (!opts.pricing) {
        deps.logger.warn(
          '未提供 pricing，costUsd 恒为 0 —— limits.maxCostUsd 将不起作用，只有 token 与时间维度生效',
        );
      }

      return {
        async run(args: EngineRunArgs): Promise<JsonValue> {
          const { gateways, budget, ctx } = args;
          const modelId = typeof opts.model === 'string' ? opts.model : opts.model.modelId;

          // ── 受管入口 1：模型调用 ──
          const model = wrapLanguageModel({
            model: opts.model as Parameters<typeof wrapLanguageModel>[0]['model'],
            middleware: {
              wrapGenerate: async ({ doGenerate, params }) =>
                gateways.model.guard(
                  hashableParams(params as unknown as Record<string, unknown>),
                  async () => {
                    const result = await doGenerate();
                    return {
                      result,
                      usage: toCaUsage(result.usage as never, modelId, opts.pricing),
                    };
                  },
                ),
            },
          });

          // ── 受管入口 2：工具执行 ──
          const tools: ToolSet = Object.fromEntries(
            Object.entries(opts.tools ?? {}).map(([name, t]) => {
              const original = (t as { execute?: (i: unknown, o: unknown) => Promise<unknown> }).execute;
              if (!original) return [name, t]; // 无 execute 的客户端工具，包不了也不该包
              return [
                name,
                {
                  ...t,
                  execute: (input: unknown, options: unknown) =>
                    gateways.tools.guard(name, input as JsonValue, ({ idempotencyKey }) =>
                      // idempotencyKey 以附加字段透传给工具实现，供下游系统去重
                      original(input, { ...(options as object), idempotencyKey }),
                    ),
                },
              ];
            }),
          );

          // 运行预算翻译成原生停止条件。不由 core 强行打断循环 ——
          // 真正的硬闸门在受管入口上（超预算时下一次调用直接抛）。
          const deadline = Date.now() + budget.wallClockMs;
          const stopWhen: StopCondition<ToolSet>[] = [
            isStepCount(budget.maxModelCalls),
            () => Date.now() >= deadline,
          ];

          const agent = new ToolLoopAgent({
            model,
            tools,
            ...(opts.system ? { system: opts.system } : {}),
            stopWhen,
          });

          const messages = opts.buildMessages
            ? opts.buildMessages({
                input: args.input,
                ...(args.previousAttempt !== undefined ? { previousAttempt: args.previousAttempt } : {}),
              })
            : defaultMessages(args.input);

          const result = await agent.generate({ messages, abortSignal: ctx.signal });

          // finishReason==='stop' 才是模型自己说完了。其余情况说明是我们的停止条件把它掐停的 ——
          // 那不是「完成」，据实报失败，别把半截结果当成答案交给工作流。
          if (result.finishReason !== 'stop') {
            throw new CaError(
              `agent 循环未自然结束（finishReason=${String(result.finishReason)}）：` +
                `已达 maxModelCalls=${budget.maxModelCalls} 或 wallClockMs=${budget.wallClockMs}。` +
                `请放宽 limits，或检查 agent 是否陷入了工具调用循环。`,
              false,
            );
          }

          return { text: result.text, finishReason: result.finishReason } as JsonValue;
        },
      };
    },
  };
}
