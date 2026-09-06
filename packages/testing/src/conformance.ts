/**
 * 引擎一致性套件，见 docs/architecture.md §11。
 *
 * 它把「支持任意 SDK」从口号变成可验证的契约。最关键的一条是
 * **声明的 capabilities 与实际行为一致** —— 适配器谎报能力会让用户
 * 误以为拿到了 effectively-once 与调用级成本管控，比不支持更危险。
 *
 * 刻意做成返回违规列表的纯函数，而不是 describe/it：
 * 这样才能反过来测「套件本身抓不抓得住一个说谎的引擎」。
 */
import { MemoryStateStore, runSlice } from '@ca/core';
import type { AgentEngine, AgentSpec, JsonValue, Logger } from '@ca/core';
import { makeContext, silentLogger } from '@ca/core/testkit';

export interface ConformanceViolation {
  rule: string;
  detail: string;
}

export interface ConformanceFixture {
  /**
   * 每次调用都要造一个**全新**的引擎，并暴露底层真实调用的计数器。
   * 计数器必须统计「真的打到模型 / 真的执行了工具」的次数，
   * 而不是经过受管入口的次数 —— 后者在重放时也会走到。
   */
  create(): Promise<{
    engine: AgentEngine<never>;
    spec: AgentSpec;
    input: JsonValue;
    realModelCalls(): number;
    realToolCalls(): number;
  }>;
  logger?: Logger;
}

const RUN_KEY = 'conformance:agent_ref:0';

async function runOnce(
  fixture: ConformanceFixture,
  store: MemoryStateStore,
  owner: string,
  sliceBudget?: { maxModelCalls?: number },
) {
  const made = await fixture.create();
  const lease = await store.acquire(RUN_KEY, owner, 60_000);
  if (!lease) throw new Error('conformance: 抢不到租约');
  const agent = await made.engine.build(made.spec, { logger: fixture.logger ?? silentLogger });
  const outcome = await runSlice({
    spec: made.spec,
    agent,
    input: made.input,
    ctx: makeContext({ runKey: RUN_KEY }),
    store,
    lease,
    ...(sliceBudget ? { sliceBudget } : {}),
  });
  return { made, outcome };
}

/**
 * 跑完返回违规列表；空数组表示这个引擎名副其实。
 *
 * fixture 应当提供一个「两次模型调用 + 一次工具调用后结束」的脚本，
 * 这样分片与重放两条断言才有东西可查。
 */
export async function checkEngineConformance(
  fixture: ConformanceFixture,
): Promise<ConformanceViolation[]> {
  const violations: ConformanceViolation[] = [];
  const push = (rule: string, detail: string) => violations.push({ rule, detail });

  // ── 1. 首跑：受管入口是否真的被用上 ──
  const store = new MemoryStateStore();
  const { made, outcome } = await runOnce(fixture, store, 'w1');
  const caps = made.engine.capabilities;
  const journal = await store.readJournal(RUN_KEY);
  const modelEntries = journal.filter((e) => e.kind === 'model').length;
  const toolEntries = journal.filter((e) => e.kind === 'tool.result' || e.kind === 'tool.error').length;
  const realModel = made.realModelCalls();
  const realTool = made.realToolCalls();

  if (outcome.kind === 'failed') {
    push('fixture', `首跑就失败了，后续断言无从进行：${outcome.error.message}`);
    return violations;
  }

  if (caps.costVisibility === 'per-call') {
    if (realModel > 0 && modelEntries === 0) {
      push(
        'costVisibility',
        `声明 per-call，但底层发生了 ${realModel} 次模型调用而 journal 里一条 model 条目都没有 —— ` +
          `模型调用没有经过受管入口，journal 与预算都形同虚设`,
      );
    } else if (modelEntries < realModel) {
      push('costVisibility', `声明 per-call，但 ${realModel} 次真实调用只有 ${modelEntries} 条进了 journal`);
    }
  }

  if (caps.toolInterception === 'all' && realTool > 0 && toolEntries < realTool) {
    push(
      'toolInterception',
      `声明 all，但 ${realTool} 次真实工具执行只有 ${toolEntries} 条进了 journal —— 幂等保护实际不存在`,
    );
  }

  // ── 2. 重放：journal 应当短路掉全部真实调用 ──
  const replayStore = new MemoryStateStore();
  const replayLease = await replayStore.acquire(RUN_KEY, 'w-replay', 60_000);
  await replayStore.appendJournal(
    replayLease!,
    journal.filter((e) => e.kind !== 'final' && e.kind !== 'failed'),
  );
  const replayMade = await fixture.create();
  const replayAgent = await replayMade.engine.build(replayMade.spec, {
    logger: fixture.logger ?? silentLogger,
  });
  const replayOutcome = await runSlice({
    spec: replayMade.spec,
    agent: replayAgent,
    input: replayMade.input,
    ctx: makeContext({ runKey: RUN_KEY }),
    store: replayStore,
    lease: replayLease!,
  });

  if (replayMade.realModelCalls() > 0) {
    push(
      'replay',
      `重放时底层仍发生了 ${replayMade.realModelCalls()} 次模型调用 —— 会重复付费。` +
        `通常是模型调用没走 gateways.model.guard，或引擎循环在重放时走了不同分支`,
    );
  }
  if (replayMade.realToolCalls() > 0) {
    push('replay', `重放时底层仍执行了 ${replayMade.realToolCalls()} 次工具 —— 会重复产生副作用`);
  }
  if (replayOutcome.kind !== outcome.kind) {
    push('replay', `重放结果与首跑不一致：首跑 ${outcome.kind}，重放 ${replayOutcome.kind}`);
  }

  // ── 3. 分片：声明 native 就必须真的受 SliceBudget 约束 ──
  if (caps.sliceControl === 'native' && realModel > 1) {
    const sliceStore = new MemoryStateStore();
    const sliced = await runOnce(fixture, sliceStore, 'w-slice', { maxModelCalls: 1 });
    const usedModel = sliced.made.realModelCalls();
    if (usedModel > 1) {
      push(
        'sliceControl',
        `声明 native，但 maxModelCalls=1 时底层仍调了 ${usedModel} 次模型 —— SliceBudget 没有被翻译成停止条件`,
      );
    }
    if (sliced.outcome.kind === 'done') {
      push(
        'sliceControl',
        `声明 native，但分片预算耗尽时直接返回了 done，应当返回 continue 让下一分片接着跑`,
      );
    }
  }

  return violations;
}
