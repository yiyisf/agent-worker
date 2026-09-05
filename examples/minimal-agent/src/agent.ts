/**
 * minimal-agent：一个能在 Conductor 上跑通的最小 Agent。
 *
 * 演示三件事：
 *   1. 工具与模型用 **AI SDK 的原生写法**，本 SDK 不发明第二套（ADR-0011）
 *   2. AgentSpec 是纯数据，只声明「可靠性策略」而不是工具实现（ADR-0013）
 *   3. 默认用确定性的假模型 —— 验证不需要任何 LLM key。
 *      设了 ANTHROPIC_API_KEY 就自动换成真模型。
 */
import { tool } from 'ai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createAiSdkEngine } from '@ca/engine-ai-sdk';
import type { AgentSpec } from '@ca/core';

/** 计数器：端到端测试用它断言「重放时没有重复调用」 */
export const counters = { modelCalls: 0, toolCalls: 0 };

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: o, text: o, reasoning: 0 },
});

/**
 * 假模型：先调一次工具，再给出结论。两步 —— 正好能观察分片与重放。
 * 用假模型而不是真模型，是为了让验证**可重复且零成本**；真实性由 §11 的一致性套件保证。
 */
function scriptedModel(): LanguageModel {
  let step = 0;
  return new MockLanguageModelV4({
    modelId: 'scripted/two-step',
    doGenerate: async () => {
      counters.modelCalls += 1;
      if (step++ === 0) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: `call-${step}`,
              toolName: 'lookupOrder',
              input: JSON.stringify({ orderId: 'A-1001' }),
            },
          ],
          finishReason: { unified: 'tool-calls' },
          usage: usage(120, 24),
          warnings: [],
        } as never;
      }
      return {
        content: [{ type: 'text', text: '订单 A-1001 已发货，预计明天送达。' }],
        finishReason: { unified: 'stop' },
        usage: usage(180, 36),
        warnings: [],
      } as never;
    },
  }) as unknown as LanguageModel;
}

async function resolveModel(): Promise<LanguageModel> {
  if (!process.env.ANTHROPIC_API_KEY) return scriptedModel();
  // 真模型走 AI SDK 的 provider 生态 —— 我们不维护 provider 适配（ADR-0011）
  const { anthropic } = await import('@ai-sdk/anthropic');
  return anthropic(process.env.CA_MODEL ?? 'claude-sonnet-5');
}

export async function buildEngine() {
  return createAiSdkEngine({
    model: await resolveModel(),
    system: '你是订单助手。用工具查询后，用一句话回答用户。',
    tools: {
      lookupOrder: tool({
        description: '按订单号查询物流状态',
        inputSchema: z.object({ orderId: z.string() }),
        execute: async ({ orderId }) => {
          counters.toolCalls += 1;
          return { orderId, status: 'shipped', eta: '明天' };
        },
      }),
    },
    // 没有价格表 costUsd 就恒为 0，limits.maxCostUsd 会失效 —— build 时会告警
    pricing: ({ inputTokens, outputTokens }) => inputTokens * 3e-6 + outputTokens * 1.5e-5,
  });
}

/**
 * AgentSpec 是纯 JSON 数据：可以来自 TS、也可以来自配置中心（ADR-0013）。
 * 注意这里只声明**可靠性策略**（工具的 effect），工具实现在上面的引擎配置里。
 */
export const orderAgentSpec: AgentSpec = {
  name: 'order_assistant',
  engine: 'ai-sdk/tool-loop',
  toolPolicies: {
    // 只读查询，重放时可以自由短路
    lookupOrder: { effect: 'pure' },
  },
  limits: {
    maxCostUsd: 0.5,
    wallClockMs: 120_000,
    // 故意设小，让这个两步的 Agent 至少分成两片 —— 便于观察分片与恢复
    sliceMs: 1_000,
  },
  conductor: {
    leaseStrategy: 'callback',
    resumePolicy: 'on-lease-loss',
  },
};

export const TASK_TYPE = `agent_${orderAgentSpec.name}`;
export const WORKFLOW_NAME = 'minimal_agent_demo';
