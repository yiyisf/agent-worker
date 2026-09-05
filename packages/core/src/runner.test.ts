import { describe, expect, it } from 'vitest';
import { runSlice, decideResume } from './runner.js';
import { MemoryStateStore } from './stores/memory.js';
import { makeContext, scriptedAgent, spec } from './testkit.js';
import { AmbiguousReplayError, BudgetExceededError, FencedOutError } from './errors.js';
import type { JournalEntry, LeaseRecord } from './journal.js';
import type { AgentSpec } from './spec.js';

const RUN_KEY = 'wf-1:agent_ref:0';

async function leaseFor(store: MemoryStateStore, owner = 'w1'): Promise<LeaseRecord> {
  const lease = await store.acquire(RUN_KEY, owner, 60_000);
  if (!lease) throw new Error('acquire failed');
  return lease;
}

describe('runSlice —— journal 短路与重放', () => {
  it('重放时不再产生真实的模型调用与工具副作用', async () => {
    const store = new MemoryStateStore();
    const sideEffects: string[] = [];
    const s = spec();

    const agent = () =>
      scriptedAgent({
        sideEffects,
        steps: [
          { call: 'model', payload: { prompt: 'hi' }, response: { text: 'use tool' } },
          { call: 'tool', name: 'lookup', input: { id: 1 }, run: async () => ({ ok: true }) },
          { call: 'model', payload: { prompt: 'wrap up' }, response: { text: 'done' } },
        ],
      });

    // 第一次：全部真实执行
    const first = await runSlice({
      spec: s,
      agent: agent(),
      input: null,
      ctx: makeContext(),
      store,
      lease: await leaseFor(store),
    });
    expect(first.kind).toBe('done');
    expect(sideEffects).toEqual([
      'model:{"prompt":"hi"}',
      'tool:lookup',
      'model:{"prompt":"wrap up"}',
    ]);

    // 模拟"任务被重投"：清掉终态，重新跑同一个 runKey
    const store2 = new MemoryStateStore();
    const lease2 = await leaseFor(store2);
    const withoutFinal = (await store.readJournal(RUN_KEY)).filter((e) => e.kind !== 'final');
    await store2.appendJournal(lease2, withoutFinal);

    sideEffects.length = 0;
    const second = await runSlice({
      spec: s,
      agent: agent(),
      input: null,
      ctx: makeContext(),
      store: store2,
      lease: lease2,
    });

    expect(second.kind).toBe('done');
    // 关键断言：循环照走了一遍，但一次真实调用都没发生
    expect(sideEffects).toEqual([]);
    expect(second.kind === 'done' && second.output).toEqual(first.kind === 'done' && first.output);
  });

  it('重放时用量照记 —— 那笔钱上一次已经花掉了', async () => {
    const store = new MemoryStateStore();
    const s = spec();
    const build = () =>
      scriptedAgent({
        steps: [
          {
            call: 'model',
            payload: { p: 1 },
            response: { t: 'a' },
            usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
          },
        ],
      });

    const first = await runSlice({
      spec: s,
      agent: build(),
      input: null,
      ctx: makeContext(),
      store,
      lease: await leaseFor(store),
    });
    expect(first.budget.costUsd).toBeCloseTo(0.02);

    const store2 = new MemoryStateStore();
    const lease2 = await leaseFor(store2);
    await store2.appendJournal(
      lease2,
      (await store.readJournal(RUN_KEY)).filter((e) => e.kind !== 'final'),
    );
    const second = await runSlice({
      spec: s,
      agent: build(),
      input: null,
      ctx: makeContext(),
      store: store2,
      lease: lease2,
    });
    expect(second.budget.costUsd).toBeCloseTo(0.02);
    expect(second.budget.modelCalls).toBe(1);
  });

  it('已有终态时重入直接返回，不重跑', async () => {
    const store = new MemoryStateStore();
    const sideEffects: string[] = [];
    const s = spec();
    const build = () =>
      scriptedAgent({
        sideEffects,
        steps: [{ call: 'model', payload: { p: 1 }, response: { t: 'a' } }],
      });

    const lease = await leaseFor(store);
    await runSlice({ spec: s, agent: build(), input: null, ctx: makeContext(), store, lease });
    sideEffects.length = 0;

    const again = await runSlice({ spec: s, agent: build(), input: null, ctx: makeContext(), store, lease });
    expect(again.kind).toBe('done');
    expect(sideEffects).toEqual([]);
  });
});

describe('副作用与幂等（ADR-0005）', () => {
  const effectfulSpec = (mode?: 'fail' | 'retry'): AgentSpec =>
    spec({
      toolPolicies: {
        charge: { effect: 'effectful', ...(mode ? { onAmbiguousReplay: mode } : {}) },
      },
    });

  /** 造一个「只有 intent 没有 result」的 journal —— 工具执行到一半进程没了 */
  async function withDanglingIntent(store: MemoryStateStore, lease: LeaseRecord): Promise<void> {
    const probe = new MemoryStateStore();
    const l = (await probe.acquire(RUN_KEY, 'probe', 60_000))!;
    let crashed = false;
    await runSlice({
      spec: effectfulSpec(),
      agent: scriptedAgent({
        steps: [
          {
            call: 'tool',
            name: 'charge',
            input: { amount: 100 },
            run: async () => {
              crashed = true;
              throw Object.assign(new Error('进程在此消失'), { __crash: true });
            },
          },
        ],
      }),
      input: null,
      ctx: makeContext(),
      store: probe,
      lease: l,
    }).catch(() => undefined);
    expect(crashed).toBe(true);
    // 只搬 intent，丢掉 result/error —— 模拟「执行了但结果没能落盘」
    const intents = (await probe.readJournal(RUN_KEY)).filter((e) => e.kind === 'tool.intent');
    expect(intents).toHaveLength(1);
    await store.appendJournal(lease, intents as JournalEntry[]);
  }

  it('effectful 工具遇到模糊重放时默认终局失败，而不是悄悄重跑', async () => {
    const store = new MemoryStateStore();
    const lease = await leaseFor(store);
    await withDanglingIntent(store, lease);

    const sideEffects: string[] = [];
    const outcome = await runSlice({
      spec: effectfulSpec(),
      agent: scriptedAgent({
        sideEffects,
        steps: [{ call: 'tool', name: 'charge', input: { amount: 100 }, run: async () => ({ ok: true }) }],
      }),
      input: null,
      ctx: makeContext(),
      store,
      lease,
    });

    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error.name).toBe(AmbiguousReplayError.name);
    expect(outcome.kind === 'failed' && outcome.error.retryable).toBe(false);
    // 最关键的一条：没有重复扣款
    expect(sideEffects).toEqual([]);
  });

  it('显式选 retry 时才会重跑', async () => {
    const store = new MemoryStateStore();
    const lease = await leaseFor(store);
    await withDanglingIntent(store, lease);

    const sideEffects: string[] = [];
    const outcome = await runSlice({
      spec: effectfulSpec('retry'),
      agent: scriptedAgent({
        sideEffects,
        steps: [{ call: 'tool', name: 'charge', input: { amount: 100 }, run: async () => ({ ok: true }) }],
      }),
      input: null,
      ctx: makeContext(),
      store,
      lease,
    });

    expect(outcome.kind).toBe('done');
    expect(sideEffects).toEqual(['tool:charge']);
  });

  it('非 pure 工具的 idempotencyKey 就是 stepId，且跨重放稳定', async () => {
    const store = new MemoryStateStore();
    const keys: string[] = [];
    const s = spec({ toolPolicies: { send: { effect: 'idempotent' } } });
    const build = () =>
      scriptedAgent({
        steps: [
          {
            call: 'tool',
            name: 'send',
            input: { to: 'a' },
            run: async ({ idempotencyKey }) => {
              keys.push(idempotencyKey);
              return { sent: true };
            },
          },
        ],
      });

    await runSlice({
      spec: s,
      agent: build(),
      input: null,
      ctx: makeContext(),
      store,
      lease: await leaseFor(store),
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}#0$/);
  });
});

describe('预算治理', () => {
  it('成本超限时在调用前拦住', async () => {
    const store = new MemoryStateStore();
    const s = spec({ limits: { maxCostUsd: 0.015 } });
    const sideEffects: string[] = [];
    const outcome = await runSlice({
      spec: s,
      agent: scriptedAgent({
        sideEffects,
        steps: [
          { call: 'model', payload: { p: 1 }, response: { t: 1 }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } },
          { call: 'model', payload: { p: 2 }, response: { t: 2 }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } },
          { call: 'model', payload: { p: 3 }, response: { t: 3 }, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } },
        ],
      }),
      input: null,
      ctx: makeContext(),
      store,
      lease: await leaseFor(store),
    });

    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.error.name).toBe(BudgetExceededError.name);
    // 第 3 次调用没有发生：0.01 + 0.01 已经超过 0.015
    expect(sideEffects).toHaveLength(2);
  });

  it('用量跨分片累计，不是每片从 0 开始', async () => {
    const store = new MemoryStateStore();
    const lease = await leaseFor(store);
    const s = spec({ limits: { maxCostUsd: 0.05 } });

    const sliceAgent = (payload: number) =>
      scriptedAgent({
        steps: [
          {
            call: 'model',
            payload: { p: payload },
            response: { t: payload },
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02 },
          },
        ],
        finish: (state) => ({ kind: 'continue', state }),
      });

    const a = await runSlice({ spec: s, agent: sliceAgent(1), input: null, ctx: makeContext(), store, lease });
    expect(a.kind).toBe('continue');
    expect(a.budget.costUsd).toBeCloseTo(0.02);

    const b = await runSlice({ spec: s, agent: sliceAgent(2), input: null, ctx: makeContext(), store, lease });
    expect(b.budget.costUsd).toBeCloseTo(0.04);
  });
});

describe('Fencing（§5.3）', () => {
  it('租约未过期时，另一个 worker 抢不到', async () => {
    const store = new MemoryStateStore();
    await store.acquire(RUN_KEY, 'w1', 60_000);
    // 这正是 fencing 的第一道闸：抢不到就该立即放弃，而不是并发跑
    expect(await store.acquire(RUN_KEY, 'w2', 60_000)).toBeUndefined();
  });

  it('租约过期后被接管，旧 worker 的写入被拒绝且错误上抛而非吞掉', async () => {
    let clock = 1_000;
    const store = new MemoryStateStore(() => clock);
    const stale = (await store.acquire(RUN_KEY, 'w1', 5_000))!;

    clock += 10_000; // 旧租约到期
    const fresh = (await store.acquire(RUN_KEY, 'w2', 60_000))!;
    expect(fresh.fenceToken).toBeGreaterThan(stale.fenceToken);

    // 旧 worker 还在跑，它的任何写入都必须被拒绝
    await expect(
      runSlice({
        spec: spec(),
        agent: scriptedAgent({ steps: [{ call: 'model', payload: { p: 1 }, response: { t: 1 } }] }),
        input: null,
        ctx: makeContext(),
        store,
        lease: stale,
      }),
    ).rejects.toBeInstanceOf(FencedOutError);
  });
});

describe('分片与挂起', () => {
  it('continue 会保存引擎状态，下一片从该状态继续', async () => {
    const store = new MemoryStateStore();
    const lease = await leaseFor(store);
    const seen: unknown[] = [];

    const mk = (label: string) => ({
      async run(args: Parameters<ReturnType<typeof scriptedAgent>['run']>[0]) {
        seen.push(args.state);
        return { kind: 'continue' as const, state: { at: label } };
      },
    });

    await runSlice({ spec: spec(), agent: mk('a'), input: null, ctx: makeContext(), store, lease });
    await runSlice({ spec: spec(), agent: mk('b'), input: null, ctx: makeContext(), store, lease });
    expect(seen).toEqual([undefined, { at: 'a' }]);
  });

  it('suspended 会落 journal 并返回 resumeToken，恢复时把外部结果回灌给引擎', async () => {
    const store = new MemoryStateStore();
    const lease = await leaseFor(store);
    let resumed: unknown;

    const suspending = {
      async run() {
        return {
          kind: 'suspended' as const,
          state: { pending: true },
          awaiting: { kind: 'approval' as const, ref: 'appr-1', toolName: 'refund' },
        };
      },
    };
    const out = await runSlice({ spec: spec(), agent: suspending, input: null, ctx: makeContext(), store, lease });
    expect(out.kind).toBe('suspended');
    expect(out.kind === 'suspended' && out.awaiting.ref).toBe('appr-1');
    expect(out.kind === 'suspended' && out.resumeToken).toMatch(/^unsigned\./);

    const resuming = {
      async run(args: { resumeWith?: unknown }) {
        resumed = args.resumeWith;
        return { kind: 'done' as const, output: { ok: true } };
      },
    };
    const done = await runSlice({
      spec: spec(),
      agent: resuming,
      input: null,
      ctx: makeContext(),
      store,
      lease,
      resumeWith: { approved: true },
    });
    expect(done.kind).toBe('done');
    expect(resumed).toEqual({ approved: true });
  });
});

describe('decideResume（ADR-0016）', () => {
  const entry = (kind: JournalEntry['kind']): JournalEntry =>
    ({ seq: 0, kind, budget: { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, modelCalls: 0 } }) as JournalEntry;

  it('无终态条目 → 判定为崩溃，续跑', () => {
    expect(decideResume([entry('model')], 'on-lease-loss').action).toBe('continue');
    expect(decideResume([entry('model')], 'fresh-per-retry').action).toBe('continue');
  });

  it('有终态条目 → 判定为业务失败，按策略决定', () => {
    expect(decideResume([entry('failed')], 'fresh-per-retry').action).toBe('restart');
    expect(decideResume([entry('failed')], 'on-lease-loss').action).toBe('continue');
  });

  it('resumePolicy=never 一律重开', () => {
    expect(decideResume([entry('model')], 'never').action).toBe('restart');
  });
});

describe('瞬时错误不写终态（ADR-0016 前提）', () => {
  it('可重试错误不落 failed 条目，已完成的步骤得以保留、下次接着跑', async () => {
    const store = new MemoryStateStore();
    const lease = await leaseFor(store);
    const sideEffects: string[] = [];

    // 先完成一次模型调用，再抛瞬时错误 —— 这才是真实的"跑了一半失败"
    const flaky = scriptedAgent({
      sideEffects,
      steps: [{ call: 'model', payload: { p: 1 }, response: { t: 1 } }],
      finish: () => {
        throw new Error('429 rate limited');
      },
    });

    const out = await runSlice({ spec: spec(), agent: flaky, input: null, ctx: makeContext(), store, lease });
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.error.retryable).toBe(true);

    const journal = await store.readJournal(RUN_KEY);
    expect(journal.some((e) => e.kind === 'failed')).toBe(false);
    expect(journal.some((e) => e.kind === 'model')).toBe(true);
    expect(decideResume(journal, 'on-lease-loss').action).toBe('continue');

    // 重试时那次模型调用被 journal 短路，不重复付费
    sideEffects.length = 0;
    const retry = await runSlice({
      spec: spec(),
      agent: scriptedAgent({
        sideEffects,
        steps: [{ call: 'model', payload: { p: 1 }, response: { t: 1 } }],
      }),
      input: null,
      ctx: makeContext(),
      store,
      lease,
    });
    expect(retry.kind).toBe('done');
    expect(sideEffects).toEqual([]);
  });

  it('空 journal 没有可续跑的东西，判定为重开', () => {
    expect(decideResume([], 'on-lease-loss').action).toBe('restart');
  });
});
