import { describe, expect, it } from 'vitest';
import type { AgentEngine, AgentSpec, EngineCapabilities, JsonValue } from '@ca/core';
import { checkEngineConformance, type ConformanceFixture } from './conformance.js';

const honestCaps: EngineCapabilities = {
  costVisibility: 'per-call',
  toolInterception: 'all',
  state: 'messages',
  suspend: 'native-approval',
  sliceControl: 'native',
  granularity: 'step',
  progress: 'step',
  streaming: false,
  structuredOutput: false,
};

const spec: AgentSpec = { name: 'fake', engine: 'fake' };

/**
 * 造一个「两次模型调用 + 一次工具调用」的假引擎。
 * @param cheat 'none' 老实走受管入口；'bypass-model' 绕开模型入口；'ignore-slice' 无视分片预算
 */
function fixture(cheat: 'none' | 'bypass-model' | 'ignore-slice'): ConformanceFixture {
  return {
    async create() {
      let realModel = 0;
      let realTool = 0;
      const engine: AgentEngine<never> = {
        id: 'fake',
        contractVersion: 1,
        capabilities: honestCaps,
        builtinTools: [],
        async build() {
          return {
            async run({ gateways, budget }) {
              const callModel = async (n: number) => {
                if (cheat === 'bypass-model') {
                  realModel++; // 直接调，不经受管入口 —— 这正是要被抓的行为
                  return { step: n };
                }
                return gateways.model.guard({ step: n }, async () => {
                  realModel++;
                  return {
                    result: { step: n },
                    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
                  };
                });
              };

              await callModel(1);
              await gateways.tools.guard('lookup', { id: 1 }, async () => {
                realTool++;
                return { found: 1 };
              });

              // 分片预算：老实的引擎跑满一次模型调用就该交还
              if (cheat !== 'ignore-slice' && budget.maxModelCalls <= 1) {
                return { kind: 'continue', state: { at: 1 } as never };
              }
              await callModel(2);
              return { kind: 'done', output: { ok: true } as JsonValue };
            },
          };
        },
      };
      return {
        engine,
        spec,
        input: 'go' as JsonValue,
        realModelCalls: () => realModel,
        realToolCalls: () => realTool,
      };
    },
  };
}

describe('引擎一致性套件', () => {
  it('老实的引擎零违规', async () => {
    expect(await checkEngineConformance(fixture('none'))).toEqual([]);
  });

  it('抓得住「声明 per-call 却绕开模型入口」的引擎', async () => {
    const violations = await checkEngineConformance(fixture('bypass-model'));
    expect(violations.map((v) => v.rule)).toContain('costVisibility');
    // 绕开入口还意味着重放时会重复付费，这一条也要报出来
    expect(violations.map((v) => v.rule)).toContain('replay');
  });

  it('抓得住「声明 sliceControl=native 却无视分片预算」的引擎', async () => {
    const violations = await checkEngineConformance(fixture('ignore-slice'));
    expect(violations.map((v) => v.rule)).toContain('sliceControl');
  });
});
