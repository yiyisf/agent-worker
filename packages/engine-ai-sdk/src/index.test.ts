import { describe, expect, it } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { MemoryStateStore, assertCapabilities, runSlice } from '@ca/core';
import type { AgentSpec, LeaseRecord } from '@ca/core';
import { makeContext } from '@ca/core/testkit';
import { createAiSdkEngine } from './index.js';

const RUN_KEY = 'wf-1:agent_ref:0';

const usage = (i: number, o: number) => ({
  inputTokens: { total: i, noCache: i, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: o, text: o, reasoning: 0 },
});

const toolCallStep = (id: string, input: unknown) => ({
  content: [
    { type: 'tool-call' as const, toolCallId: id, toolName: 'lookup', input: JSON.stringify(input) },
  ],
  finishReason: { unified: 'tool-calls' as const },
  usage: usage(10, 5),
  warnings: [],
});

const textStep = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const },
  usage: usage(20, 8),
  warnings: [],
});

function scriptedModel(responses: unknown[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => responses[i++] as never,
  });
}

function lookupTool(onExecute: () => void) {
  return tool({
    description: 'look something up',
    inputSchema: z.object({ id: z.number() }),
    execute: async ({ id }) => {
      onExecute();
      return { found: id };
    },
  });
}

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  name: 'probe',
  engine: 'ai-sdk/tool-loop',
  ...over,
});

async function leaseFor(store: MemoryStateStore, owner = 'w1'): Promise<LeaseRecord> {
  const lease = await store.acquire(RUN_KEY, owner, 60_000);
  if (!lease) throw new Error('acquire failed');
  return lease;
}

describe('@ca/engine-ai-sdk —— 适配器的唯一义务', () => {
  it('模型调用与工具执行都经过受管入口，落进 journal', async () => {
    const store = new MemoryStateStore();
    let toolRuns = 0;
    const model = scriptedModel([toolCallStep('c1', { id: 1 }), textStep('完成')]);
    const engine = createAiSdkEngine({
      model,
      tools: { lookup: lookupTool(() => void toolRuns++) },
      pricing: ({ inputTokens, outputTokens }) => inputTokens * 1e-5 + outputTokens * 3e-5,
    });

    const agent = await engine.build(spec(), { logger: console });
    const out = await runSlice({
      spec: spec(),
      agent,
      input: '查一下 1',
      ctx: makeContext(),
      store,
      lease: await leaseFor(store),
    });

    expect(out.kind).toBe('done');
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(toolRuns).toBe(1);

    const journal = await store.readJournal(RUN_KEY);
    expect(journal.filter((e) => e.kind === 'model')).toHaveLength(2);
    expect(journal.filter((e) => e.kind === 'tool.result')).toHaveLength(1);

    // V4 的 usage 是嵌套结构，映射成扁平的 core Usage
    expect(out.budget.inputTokens).toBe(30);
    expect(out.budget.outputTokens).toBe(13);
    expect(out.budget.costUsd).toBeCloseTo(30 * 1e-5 + 13 * 3e-5);
  });

  it('重放时循环照走，但模型与工具都不再被真实调用', async () => {
    const store = new MemoryStateStore();
    const lease = await leaseFor(store);
    const build = () => {
      let toolRuns = 0;
      const model = scriptedModel([toolCallStep('c1', { id: 1 }), textStep('完成')]);
      const engine = createAiSdkEngine({
        model,
        tools: { lookup: lookupTool(() => void toolRuns++) },
      });
      return { model, engine, runs: () => toolRuns };
    };

    const first = build();
    const a1 = await first.engine.build(spec(), { logger: console });
    const r1 = await runSlice({ spec: spec(), agent: a1, input: '查一下 1', ctx: makeContext(), store, lease });
    expect(r1.kind).toBe('done');
    expect(first.model.doGenerateCalls).toHaveLength(2);
    expect(first.runs()).toBe(1);

    // 把终态摘掉，模拟"任务被重投"
    const store2 = new MemoryStateStore();
    const lease2 = await leaseFor(store2);
    await store2.appendJournal(
      lease2,
      (await store.readJournal(RUN_KEY)).filter((e) => e.kind !== 'final'),
    );

    const second = build();
    const a2 = await second.engine.build(spec(), { logger: console });
    const r2 = await runSlice({
      spec: spec(),
      agent: a2,
      input: '查一下 1',
      ctx: makeContext(),
      store: store2,
      lease: lease2,
    });

    expect(r2.kind).toBe('done');
    // 关键：AI SDK 的循环完整跑了一遍，但底层模型与工具一次都没被真的调用
    expect(second.model.doGenerateCalls).toHaveLength(0);
    expect(second.runs()).toBe(0);
    expect(r2.kind === 'done' && r2.output).toEqual(r1.kind === 'done' && r1.output);
  });
});

describe('分片（ADR-0015：core 给预算、引擎翻译成 stopWhen）', () => {
  it('分片预算耗尽时返回 continue，下一片接着跑到完成', async () => {
    const store = new MemoryStateStore();
    const lease = await leaseFor(store);
    let toolRuns = 0;
    const model = scriptedModel([toolCallStep('c1', { id: 1 }), textStep('完成')]);
    const engine = createAiSdkEngine({ model, tools: { lookup: lookupTool(() => void toolRuns++) } });
    const agent = await engine.build(spec(), { logger: console });

    const s1 = await runSlice({
      spec: spec(),
      agent,
      input: '查一下 1',
      ctx: makeContext(),
      store,
      lease,
      sliceBudget: { maxModelCalls: 1 },
    });
    expect(s1.kind).toBe('continue');
    expect(model.doGenerateCalls).toHaveLength(1);

    const s2 = await runSlice({
      spec: spec(),
      agent,
      input: '查一下 1',
      ctx: makeContext(),
      store,
      lease,
      sliceBudget: { maxModelCalls: 8 },
    });
    expect(s2.kind).toBe('done');
    // 第二片没有重复第一片的模型调用（被 journal 短路），只新增了收尾那次
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(toolRuns).toBe(1);
    // 用量跨分片累计
    expect(s2.budget.modelCalls).toBe(2);
  });
});

describe('挂起（§4.7：原生两段式审批映射到 EngineTurn.suspended）', () => {
  it('toolApproval 触发时返回 suspended，并带上 approvalId', async () => {
    const store = new MemoryStateStore();
    let toolRuns = 0;
    const model = scriptedModel([toolCallStep('c1', { id: 1 }), textStep('完成')]);
    const engine = createAiSdkEngine({
      model,
      tools: { lookup: lookupTool(() => void toolRuns++) },
      toolApproval: { lookup: 'user-approval' },
    });
    const agent = await engine.build(spec(), { logger: console });

    const out = await runSlice({
      spec: spec(),
      agent,
      input: '查一下 1',
      ctx: makeContext(),
      store,
      lease: await leaseFor(store),
    });

    expect(out.kind).toBe('suspended');
    expect(out.kind === 'suspended' && out.awaiting.kind).toBe('approval');
    expect(out.kind === 'suspended' && out.awaiting.ref).toMatch(/.+/);
    expect(out.kind === 'suspended' && out.awaiting.toolName).toBe('lookup');
    // 审批未通过前工具不执行
    expect(toolRuns).toBe(0);

    // 挂起状态与 resumeToken 已落 journal
    const journal = await store.readJournal(RUN_KEY);
    expect(journal.filter((e) => e.kind === 'suspend')).toHaveLength(1);
  });
});

describe('能力声明与实际行为一致（§11 一致性套件的核心断言）', () => {
  it('声明 costVisibility=per-call / toolInterception=all，且校验放行', () => {
    const engine = createAiSdkEngine({ model: scriptedModel([]) });
    expect(engine.capabilities.costVisibility).toBe('per-call');
    expect(engine.capabilities.toolInterception).toBe('all');
    expect(engine.builtinTools).toEqual([]);
    expect(assertCapabilities(spec(), engine.capabilities).warnings).toEqual([]);
  });

  it('声明了 effectful 工具也能通过校验（因为 toolInterception=all）', () => {
    const engine = createAiSdkEngine({ model: scriptedModel([]) });
    const s = spec({ toolPolicies: { charge: { effect: 'effectful' } } });
    expect(() => assertCapabilities(s, engine.capabilities)).not.toThrow();
  });
});
