/**
 * 引擎一致性套件，见 docs/architecture.md §11。
 *
 * 它把「支持任意 SDK」从口号变成可验证的契约。最关键的一条是
 * **声明的 capabilities 与实际行为一致** —— 适配器谎报能力会让用户
 * 误以为拿到了调用级成本管控与副作用保护，比不支持更危险。
 *
 * 刻意做成返回违规列表的纯函数，而不是 describe/it：
 * 这样才能反过来测「套件本身抓不抓得住一个说谎的引擎」。
 */
import { runAgent } from '@ca/core';
import type { AgentEngine, AgentEvent, AgentSpec, JsonValue, Logger } from '@ca/core';
import { silentLogger, testContext } from '@ca/core/testkit';

export interface ConformanceViolation {
  rule: string;
  detail: string;
}

export interface ConformanceFixture {
  /**
   * 每次调用都要造一个**全新**的引擎，并暴露底层真实调用的计数器。
   * 计数器必须统计「真的打到模型 / 真的执行了工具」的次数，
   * 而不是经过受管入口的次数 —— 两者的差值正是本套件要检查的东西。
   */
  create(): Promise<{
    engine: AgentEngine;
    spec: AgentSpec;
    input: JsonValue;
    realModelCalls(): number;
    realToolCalls(): number;
  }>;
  logger?: Logger;
}

async function runOnce(fixture: ConformanceFixture, specOver: Partial<AgentSpec> = {}) {
  const made = await fixture.create();
  const spec: AgentSpec = { ...made.spec, ...specOver, limits: { ...made.spec.limits, ...specOver.limits } };
  const events: AgentEvent[] = [];
  const agent = await made.engine.build(spec, { logger: fixture.logger ?? silentLogger });
  const outcome = await runAgent({
    spec,
    agent,
    input: made.input,
    ctx: testContext({ emit: (e) => events.push(e) }),
  });
  const managedModelCalls = events.filter((e) => e.type === 'model.call').length;
  const managedToolCalls = events.filter((e) => e.type === 'tool.started').length;
  return { made, outcome, events, managedModelCalls, managedToolCalls };
}

/**
 * 检查一个引擎适配器是否守住了它自己声明的契约。
 * 返回空数组即通过；否则每条违规都指明「哪条规则、实际怎样」。
 */
export async function checkEngineConformance(
  fixture: ConformanceFixture,
): Promise<ConformanceViolation[]> {
  const v: ConformanceViolation[] = [];
  const probe = await fixture.create();
  const caps = probe.engine.capabilities;

  if (!Number.isInteger(probe.engine.contractVersion) || probe.engine.contractVersion < 1) {
    v.push({
      rule: 'contractVersion',
      detail: `contractVersion 必须是 ≥1 的整数，实际 ${String(probe.engine.contractVersion)}`,
    });
  }

  // ── 规则 1：跑得通 ──
  const base = await runOnce(fixture);
  if (base.outcome.kind !== 'done') {
    v.push({
      rule: 'baseline',
      detail: `基准运行没有成功完成：${JSON.stringify(base.outcome)}`,
    });
    return v; // 基准都跑不通，后面的检查没有意义
  }

  // ── 规则 2：costVisibility='per-call' 必须每次模型调用都经过受管入口 ──
  if (caps.costVisibility === 'per-call') {
    const real = base.made.realModelCalls();
    if (real !== base.managedModelCalls) {
      v.push({
        rule: 'costVisibility=per-call',
        detail:
          `真实模型调用 ${real} 次，但只有 ${base.managedModelCalls} 次经过受管入口。` +
          `差额部分完全不受预算管控 —— 要么修适配器，要么把 costVisibility 降级为 'per-turn'。`,
      });
    }
    if (base.outcome.budget.modelCalls !== base.managedModelCalls) {
      v.push({
        rule: 'costVisibility=per-call',
        detail: `记账的模型调用数（${base.outcome.budget.modelCalls}）与受管入口计数（${base.managedModelCalls}）不一致`,
      });
    }
  }

  // ── 规则 3：toolInterception='all' 必须每次工具执行都经过受管入口 ──
  if (caps.toolInterception === 'all') {
    const real = base.made.realToolCalls();
    if (real !== base.managedToolCalls) {
      v.push({
        rule: 'toolInterception=all',
        detail:
          `真实工具执行 ${real} 次，但只有 ${base.managedToolCalls} 次经过受管入口。` +
          `差额部分没有幂等键、没有超时、不计入预算 —— 应改声明为 'host-declared-only'。`,
      });
    }
  }

  // ── 规则 4：预算是硬闸门，不是事后统计 ──
  const capped = await runOnce(fixture, { limits: { maxCostUsd: 1e-12, maxTotalTokens: 1 } });
  if (capped.outcome.kind !== 'failed') {
    v.push({
      rule: 'budget-enforced',
      detail: '把 maxTotalTokens 压到 1 之后运行仍然成功完成，说明预算闸门没有生效',
    });
  }
  if (capped.made.realModelCalls() > base.made.realModelCalls()) {
    v.push({
      rule: 'budget-enforced',
      detail: '预算被压到极小之后真实调用次数反而更多，说明闸门位置不对',
    });
  }

  // ── 规则 5：取消信号必须被尊重 ──
  const cancelled = await (async () => {
    const made = await fixture.create();
    const controller = new AbortController();
    controller.abort(new Error('cancelled by conformance suite'));
    const agent = await made.engine.build(made.spec, { logger: fixture.logger ?? silentLogger });
    const outcome = await runAgent({
      spec: made.spec,
      agent,
      input: made.input,
      ctx: testContext({ signal: controller.signal }),
    });
    return { made, outcome };
  })();
  if (cancelled.outcome.kind !== 'failed' || cancelled.made.realModelCalls() > 0) {
    v.push({
      rule: 'cancellation',
      detail:
        `signal 已 abort 却仍然跑了 ${cancelled.made.realModelCalls()} 次真实模型调用。` +
        `工作流被终止后继续烧 token 是最贵的一类 bug。`,
    });
  }

  return v;
}
