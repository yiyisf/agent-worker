/** 适配器必须通过一致性套件 —— 声明的 capabilities 与实际行为一致 */
import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { checkEngineConformance } from '@ca/testing';
import type { AgentSpec, JsonValue } from '@ca/core';
import { createAiSdkEngine } from './index.js';

describe('ai-sdk/tool-loop 一致性', () => {
  it('零违规', async () => {
    const violations = await checkEngineConformance({
      async create() {
        let modelCalls = 0;
        let toolCalls = 0;
        const model = new MockLanguageModelV4({
          doGenerate: async () => {
            modelCalls += 1;
            const usage = {
              inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 10, text: 10, reasoning: 0 },
            };
            if (modelCalls === 1) {
              return {
                content: [
                  { type: 'tool-call' as const, toolCallId: 'c1', toolName: 'echo', input: '{"v":1}' },
                ],
                finishReason: { unified: 'tool-calls' as const },
                usage,
                warnings: [],
              } as never;
            }
            return {
              content: [{ type: 'text' as const, text: 'ok' }],
              finishReason: { unified: 'stop' as const },
              usage,
              warnings: [],
            } as never;
          },
        });
        const engine = createAiSdkEngine({
          model: model as never,
          tools: {
            echo: tool({
              description: 'echo',
              inputSchema: z.object({ v: z.number() }),
              execute: async ({ v }: { v: number }) => {
                toolCalls += 1;
                return { v };
              },
            }),
          },
          pricing: ({ inputTokens }) => inputTokens * 1e-6,
        });
        const spec: AgentSpec = { name: 'conf', engine: 'ai-sdk/tool-loop' };
        return {
          engine,
          spec,
          input: 'go' as JsonValue,
          realModelCalls: () => modelCalls,
          realToolCalls: () => toolCalls,
        };
      },
    });
    expect(violations).toEqual([]);
  }, 30_000);
});
