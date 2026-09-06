import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { checkEngineConformance } from '@ca/testing';
import type { AgentSpec, JsonValue } from '@ca/core';
import { createAiSdkEngine } from './index.js';

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: o, text: o, reasoning: 0 },
});

describe('engine-ai-sdk 通过引擎一致性套件', () => {
  it('声明的 capabilities 与实际行为一致，零违规', async () => {
    const violations = await checkEngineConformance({
      async create() {
        let realModel = 0;
        let realTool = 0;
        let i = 0;
        const responses = [
          {
            content: [
              { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: JSON.stringify({ id: 1 }) },
            ],
            finishReason: { unified: 'tool-calls' },
            usage: usage(10, 5),
            warnings: [],
          },
          {
            content: [{ type: 'text', text: '完成' }],
            finishReason: { unified: 'stop' },
            usage: usage(20, 8),
            warnings: [],
          },
        ];
        const model = new MockLanguageModelV4({
          doGenerate: async () => {
            realModel++;
            return responses[i++] as never;
          },
        });
        const engine = createAiSdkEngine({
          model,
          tools: {
            lookup: tool({
              description: 'x',
              inputSchema: z.object({ id: z.number() }),
              execute: async ({ id }) => {
                realTool++;
                return { found: id };
              },
            }),
          },
          pricing: ({ inputTokens, outputTokens }) => inputTokens * 1e-5 + outputTokens * 3e-5,
        });
        return {
          engine: engine as never,
          spec: { name: 'probe', engine: 'ai-sdk/tool-loop' } satisfies AgentSpec,
          input: '查一下 1' as JsonValue,
          realModelCalls: () => realModel,
          realToolCalls: () => realTool,
        };
      },
    });

    expect(violations).toEqual([]);
  });
});
