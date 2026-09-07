/**
 * 反向测试：一致性套件本身抓不抓得住一个**说谎**的引擎。
 * 套件写成纯函数就是为了能这样测它。
 */
import { describe, expect, it } from 'vitest';
import type { AgentEngine, AgentSpec, EngineCapabilities, JsonValue } from '@ca/core';
import { checkEngineConformance, type ConformanceFixture } from './conformance.js';

const honestCaps: EngineCapabilities = {
  costVisibility: 'per-call',
  toolInterception: 'all',
  suspend: 'none',
  progress: 'step',
  streaming: false,
  structuredOutput: false,
};

const spec: AgentSpec = { name: 'fake', engine: 'fake' };

/**
 * 造一个「两次模型调用 + 一次工具调用」的假引擎。
 * @param cheat 'none' 老实走受管入口；'bypass-model' 绕开模型入口；
 *              'bypass-tool' 绕开工具入口；'rogue' 既绕开模型入口又无视取消信号
 *
 * 注意：只无视取消信号但仍走受管入口的引擎**不构成违规** ——
 * 受管入口自己就会 throwIfAborted。取消检查真正能抓到的是绕开入口的引擎。
 */
function fixture(cheat: 'none' | 'bypass-model' | 'bypass-tool' | 'rogue'): ConformanceFixture {
  return {
    async create() {
      let realModel = 0;
      let realTool = 0;
      const engine: AgentEngine = {
        id: 'fake',
        contractVersion: 1,
        capabilities: honestCaps,
        builtinTools: [],
        async build() {
          return {
            async run({ gateways, ctx }) {
              if (cheat !== 'rogue') ctx.signal.throwIfAborted();

              const callModel = async (n: number) => {
                if (cheat === 'bypass-model' || cheat === 'rogue') {
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
              if (cheat === 'bypass-tool') {
                realTool++;
              } else {
                await gateways.tools.guard('lookup', { id: 1 }, async () => {
                  realTool++;
                  return { found: 1 };
                });
              }
              await callModel(2);
              return { ok: true } as JsonValue;
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
    expect(violations.map((v) => v.rule)).toContain('costVisibility=per-call');
  });

  it('抓得住「声明 toolInterception=all 却绕开工具入口」的引擎', async () => {
    const violations = await checkEngineConformance(fixture('bypass-tool'));
    expect(violations.map((v) => v.rule)).toContain('toolInterception=all');
  });

  it('抓得住「工作流已终止仍继续烧 token」的引擎', async () => {
    const violations = await checkEngineConformance(fixture('rogue'));
    expect(violations.map((v) => v.rule)).toContain('cancellation');
    expect(violations.map((v) => v.rule)).toContain('costVisibility=per-call');
  });
});
