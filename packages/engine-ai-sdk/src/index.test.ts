/**
 * AI SDK 适配器：只验证**适配器的义务**，不验证 AI SDK 自己的行为。
 * 义务只有一条 —— 模型调用与工具执行都必须经过受管入口。
 */
import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { runAgent } from '@ca/core';
import type { AgentEvent, AgentSpec } from '@ca/core';
import { silentLogger, testContext } from '@ca/core/testkit';
import { createAiSdkEngine } from './index.js';

const spec: AgentSpec = { name: 'demo', engine: 'ai-sdk/tool-loop' };

/** 脚本化模型：第一步调工具，第二步给答案。V4 的 finishReason/usage 都是嵌套结构 */
function scriptedModel(counter: { calls: number }) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      counter.calls += 1;
      const usage = {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 20, text: 20, reasoning: 0 },
      };
      if (counter.calls === 1) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'c1',
              toolName: 'lookupOrder',
              input: JSON.stringify({ id: 'A-1001' }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const },
          usage,
          warnings: [],
        } as never;
      }
      return {
        content: [{ type: 'text' as const, text: '订单 A-1001 已发货。' }],
        finishReason: { unified: 'stop' as const },
        usage,
        warnings: [],
      } as never;
    },
  });
}

function fixture() {
  const model = { calls: 0 };
  const toolRuns: string[] = [];
  const engine = createAiSdkEngine({
    model: scriptedModel(model) as never,
    tools: {
      lookupOrder: tool({
        description: '查订单',
        inputSchema: z.object({ id: z.string() }),
        execute: async ({ id }: { id: string }, opts: unknown) => {
          toolRuns.push((opts as { idempotencyKey?: string }).idempotencyKey ?? '');
          return { id, status: 'shipped' };
        },
      }),
    },
    pricing: ({ inputTokens, outputTokens }) => inputTokens * 3e-6 + outputTokens * 15e-6,
  });
  return { engine, model, toolRuns };
}

describe('createAiSdkEngine', () => {
  it('模型调用与工具执行都经过受管入口，用量与成本被记上', async () => {
    const { engine, model, toolRuns } = fixture();
    const events: AgentEvent[] = [];
    const agent = await engine.build(spec, { logger: silentLogger });

    const out = await runAgent({
      spec,
      agent,
      input: '查一下订单 A-1001',
      ctx: testContext({ emit: (e) => events.push(e) }),
    });

    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    expect((out.output as { text: string }).text).toContain('A-1001');

    // 真实模型调用 2 次，受管入口也是 2 次 —— 没有绕开的调用
    expect(model.calls).toBe(2);
    expect(events.filter((e) => e.type === 'model.call')).toHaveLength(2);
    expect(out.budget.modelCalls).toBe(2);

    // 工具同理，且拿到了幂等键
    expect(toolRuns).toHaveLength(1);
    expect(toolRuns[0]).toMatch(/#\d+$/);
    expect(out.budget.toolCalls).toBe(1);

    expect(out.budget.costUsd).toBeGreaterThan(0);
  });

  it('循环没自然结束（撞上停止条件）就据实报失败，不把半截结果当答案', async () => {
    const { engine } = fixture();
    const agent = await engine.build(spec, { logger: silentLogger });

    const out = await runAgent({
      spec,
      agent,
      input: 'go',
      // 只允许一步：模型会停在 tool-calls 上，不是自然结束
      runBudget: { maxModelCalls: 1 },
      ctx: testContext(),
    });

    expect(out.kind).toBe('failed');
    if (out.kind !== 'failed') return;
    expect(out.error.retryable).toBe(false);
    expect(out.error.message).toContain('未自然结束');
  });

  it('buildMessages 能拿到上一次 attempt 的输出（重试时由引擎原生携带）', async () => {
    const model = { calls: 0 };
    let seen: unknown;
    const engine = createAiSdkEngine({
      model: scriptedModel(model) as never,
      buildMessages: ({ input, previousAttempt }) => {
        seen = previousAttempt;
        return [{ role: 'user', content: String(input) }];
      },
    });
    const agent = await engine.build(spec, { logger: silentLogger });
    await runAgent({
      spec,
      agent,
      input: 'go',
      previousAttempt: { ok: false, error: { message: '上次超时' } },
      ctx: testContext(),
    });
    expect(seen).toEqual({ ok: false, error: { message: '上次超时' } });
  });
});
