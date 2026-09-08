/**
 * runAgent 的行为契约（§5.1）。
 * 关注点全部落在「受管入口拦得住什么」上 —— 那是可靠性的唯一作用点。
 */
import { describe, expect, it } from 'vitest';
import { runAgent } from './runner.js';
import { scriptedAgent, spec, testContext } from './testkit.js';
import type { AgentEvent } from './events.js';

describe('runAgent', () => {
  it('跑完一次运行并把用量记上', async () => {
    const calls: string[] = [];
    const out = await runAgent({
      spec: spec(),
      agent: scriptedAgent({
        sideEffects: calls,
        steps: [
          { call: 'model', payload: { q: 1 }, response: { a: 1 } },
          { call: 'tool', name: 'lookup', input: { id: 'A' }, run: async () => ({ ok: true }) },
          { call: 'model', payload: { q: 2 }, response: { a: 2 } },
        ],
        finish: (o) => ({ answer: o.length }),
      }),
      input: { q: 'hi' },
      ctx: testContext(),
    });

    expect(out.kind).toBe('done');
    if (out.kind !== 'done') return;
    expect(out.output).toEqual({ answer: 3 });
    expect(out.budget.modelCalls).toBe(2);
    expect(out.budget.toolCalls).toBe(1);
    // 每一步都真实发生了一次 —— 没有隐形重放，也没有隐形跳过
    expect(calls).toHaveLength(3);
  });

  it('预算在**下一次调用之前**拦住，而不是事后结账', async () => {
    const calls: string[] = [];
    const out = await runAgent({
      spec: spec({ limits: { maxCostUsd: 0.0015 } }),
      agent: scriptedAgent({
        sideEffects: calls,
        steps: [
          { call: 'model', payload: { q: 1 }, response: 'a', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } },
          { call: 'model', payload: { q: 2 }, response: 'b', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } },
          { call: 'model', payload: { q: 3 }, response: 'c' },
        ],
      }),
      input: null,
      ctx: testContext(),
    });

    expect(out.kind).toBe('failed');
    if (out.kind !== 'failed') return;
    expect(out.error.name).toBe('BudgetExceededError');
    expect(out.error.retryable).toBe(false);
    // 第三次调用**没有发生** —— 超预算是在花钱之前拦住的
    expect(calls).toHaveLength(2);
  });

  it('工具超时抛可重试错误，不会无限期挂住运行', async () => {
    const out = await runAgent({
      spec: spec({ limits: { toolCallTimeoutMs: 20 } }),
      agent: scriptedAgent({
        steps: [
          {
            call: 'tool',
            name: 'slow',
            input: {},
            run: () => new Promise((r) => setTimeout(() => r({ done: true }), 500)),
          },
        ],
      }),
      input: null,
      ctx: testContext(),
    });

    expect(out.kind).toBe('failed');
    if (out.kind !== 'failed') return;
    expect(out.error.name).toBe('CallTimeoutError');
    expect(out.error.retryable).toBe(true);
  });

  it('effectful 工具超时按**不可重试**上报：副作用是否生效未知', async () => {
    const events: AgentEvent[] = [];
    await runAgent({
      spec: spec({
        limits: { toolCallTimeoutMs: 20 },
        toolPolicies: { charge: { effect: 'effectful' } },
      }),
      agent: scriptedAgent({
        steps: [{ call: 'tool', name: 'charge', input: {}, run: () => new Promise(() => {}) }],
      }),
      input: null,
      ctx: testContext({ emit: (e) => events.push(e) }),
    });

    const failed = events.find((e) => e.type === 'tool.failed');
    expect(failed).toBeDefined();
    expect(failed && 'retryable' in failed && failed.retryable).toBe(false);
    expect(failed && 'error' in failed && failed.error).toContain('副作用是否生效未知');
  });

  it('幂等键按内容而非顺序生成：同样的调用得到同样的键', async () => {
    const seen: string[] = [];
    const step = (name: string) =>
      ({
        call: 'tool' as const,
        name,
        input: { id: 'A' },
        run: async (o: { idempotencyKey: string }) => {
          seen.push(o.idempotencyKey);
          return null;
        },
      });
    await runAgent({
      spec: spec(),
      agent: scriptedAgent({ steps: [step('t'), step('t')] }),
      input: null,
      ctx: testContext(),
    });
    // 同内容第二次出现带上出现序号，因此可区分，但前缀（内容哈希）一致
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]!.split('#')[0]).toBe(seen[1]!.split('#')[0]);
  });

  it('取消信号一旦置位，下一次受管调用立刻抛', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    controller.abort(new Error('workflow terminated'));

    const out = await runAgent({
      spec: spec(),
      agent: scriptedAgent({
        sideEffects: calls,
        steps: [{ call: 'model', payload: {}, response: 'x' }],
      }),
      input: null,
      ctx: testContext({ signal: controller.signal }),
    });

    expect(out.kind).toBe('failed');
    expect(calls).toHaveLength(0);
  });
});
