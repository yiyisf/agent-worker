/**
 * @ca/engine-ai-sdk —— 适配 Vercel AI SDK 的 ToolLoopAgent。
 * 见 docs/architecture.md §4.3、ADR-0011、ADR-0012、ADR-0015。
 *
 * 上游基线：**ai@^7.0.0**（ToolLoopAgent / toolApproval / V4 模型契约都是 v7 的能力，v5 没有）。
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
import type {
  AgentEngine,
  AgentSpec,
  BuiltAgent,
  EngineBuildDeps,
  EngineCapabilities,
  EngineRunArgs,
  EngineTurn,
  JsonValue,
  Usage,
} from '@ca/core';

/** 跨分片状态：AI SDK 的 messages 数组本身就是可序列化的对话状态 */
export interface AiSdkState {
  messages: ModelMessage[];
}

export interface AiSdkEngineOptions {
  model: LanguageModel;
  tools?: ToolSet;
  system?: string;
  /**
   * 把 V4 的 usage 换算成成本。不提供则 costUsd 为 0，
   * 此时 limits.maxCostUsd 形同虚设 —— build 时会告警。
   */
  pricing?: (args: { modelId: string; inputTokens: number; outputTokens: number }) => number;
  /** 需要人工审批的工具，映射到 EngineTurn.suspended（§4.7） */
  toolApproval?: ConstructorParameters<typeof ToolLoopAgent>[0]['toolApproval'];
}

export const AI_SDK_ENGINE_ID = 'ai-sdk/tool-loop';

export const aiSdkCapabilities: EngineCapabilities = {
  // wrapLanguageModel 拦得到每一次模型调用
  costVisibility: 'per-call',
  // 所有工具都是我们包装过的 tool({ execute })
  toolInterception: 'all',
  // messages 数组就是状态
  state: 'messages',
  // toolApproval 的两段式审批与 Conductor callback 分片同构
  suspend: 'native-approval',
  // SliceBudget 翻译成 stopWhen 自定义谓词
  sliceControl: 'native',
  granularity: 'step',
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
 * 模型请求里有不可（或不宜）参与哈希的字段：
 * abortSignal 是对象、headers 可能带每次不同的 trace id。
 * 留着它们会让 stepId 在重放时对不上。
 */
function hashableParams(params: Record<string, unknown>): JsonValue {
  const { abortSignal: _a, headers: _h, ...rest } = params;
  return JSON.parse(JSON.stringify(rest)) as JsonValue;
}

/**
 * journal 是 JSON，Date 过一遍就变成字符串了。
 * 重放时把 response.timestamp 还原成 Date，避免把降级后的形状交回给 SDK。
 */
function reviveGenerateResult(stored: unknown): unknown {
  const r = stored as { response?: { timestamp?: unknown } };
  if (r?.response?.timestamp && typeof r.response.timestamp === 'string') {
    return { ...r, response: { ...r.response, timestamp: new Date(r.response.timestamp) } };
  }
  return stored;
}

function initialMessages(input: JsonValue): ModelMessage[] {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return [{ role: 'user', content: text }];
}

export function createAiSdkEngine(opts: AiSdkEngineOptions): AgentEngine<AiSdkState> {
  return {
    id: AI_SDK_ENGINE_ID,
    // ADR-0017：只在暴露给领域包的形状破坏性变化时 +1，与上游 ai 的版本号无关
    contractVersion: 1,
    capabilities: aiSdkCapabilities,
    // ToolLoopAgent 没有内建工具，工具全部由我们声明，所以 toolInterception 才能是 'all'
    builtinTools: [],

    async build(_spec: AgentSpec, deps: EngineBuildDeps): Promise<BuiltAgent<AiSdkState>> {
      if (!opts.pricing) {
        deps.logger.warn(
          '未提供 pricing，costUsd 恒为 0 —— limits.maxCostUsd 将不起作用，只有 token 与时间维度生效',
        );
      }

      return {
        async run(args: EngineRunArgs<AiSdkState>): Promise<EngineTurn<AiSdkState>> {
          const { gateways, budget, ctx } = args;
          const modelId = typeof opts.model === 'string' ? opts.model : opts.model.modelId;

          // ── 受管入口 1：模型调用 ──
          const model = wrapLanguageModel({
            model: opts.model as Parameters<typeof wrapLanguageModel>[0]['model'],
            middleware: {
              wrapGenerate: async ({ doGenerate, params }) => {
                const stored = await gateways.model.guard(
                  hashableParams(params as unknown as Record<string, unknown>),
                  async () => {
                    const result = await doGenerate();
                    return {
                      result: result as unknown as JsonValue,
                      usage: toCaUsage(result.usage as never, modelId, opts.pricing),
                    };
                  },
                );
                return reviveGenerateResult(stored) as Awaited<ReturnType<typeof doGenerate>>;
              },
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

          // ── 分片边界：SliceBudget 翻译成 stopWhen（ADR-0015）──
          // 不由 core 强行打断 —— stopWhen 停在「最后一步有工具结果」这个干净点上，
          // 停下后 responseMessages 直接就是可续跑的状态。
          const deadline = Date.now() + budget.wallClockMs;
          const sliceConditions: StopCondition<ToolSet>[] = [
            isStepCount(budget.maxModelCalls),
            () => Date.now() >= deadline,
          ];

          const agent = new ToolLoopAgent({
            model,
            tools,
            ...(opts.system ? { system: opts.system } : {}),
            ...(opts.toolApproval ? { toolApproval: opts.toolApproval } : {}),
            stopWhen: sliceConditions,
          });

          const messages: ModelMessage[] = args.state?.messages ?? initialMessages(args.input);

          // 恢复：把外部结果（如审批决定）作为一条 tool 消息追加，再跑一轮
          if (args.resumeWith !== undefined) {
            messages.push(args.resumeWith as unknown as ModelMessage);
          }

          const result = await agent.generate({ messages, abortSignal: ctx.signal });

          // responseMessages 是跨步累计的完整对话；response.messages 只有最后一步
          const next: AiSdkState = { messages: [...messages, ...result.responseMessages] };

          // ── 挂起：原生两段式审批（§4.7）──
          const approval = result.content.find((p) => p.type === 'tool-approval-request') as
            | { approvalId: string; toolCall?: { toolName?: string; input?: unknown } }
            | undefined;
          if (approval) {
            return {
              kind: 'suspended',
              state: next,
              awaiting: {
                kind: 'approval',
                ref: approval.approvalId,
                ...(approval.toolCall?.toolName ? { toolName: approval.toolCall.toolName } : {}),
                ...(approval.toolCall?.input !== undefined
                  ? { input: approval.toolCall.input as JsonValue }
                  : {}),
              },
            };
          }

          // ── 完成 vs 本分片跑满 ──
          // finishReason==='stop' 才是模型自己说完了；其余（tool-calls 等）说明是我们的
          // 分片条件把它停下的，下一片继续。
          if (result.finishReason === 'stop') {
            return {
              kind: 'done',
              output: { text: result.text, finishReason: result.finishReason } as JsonValue,
              state: next,
            };
          }
          return { kind: 'continue', state: next };
        },
      };
    },
  };
}
