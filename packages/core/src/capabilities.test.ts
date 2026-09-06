import { describe, expect, it } from 'vitest';
import { assertCapabilities } from './capabilities.js';
import { CapabilityError } from './errors.js';
import type { EngineCapabilities } from './engine.js';
import type { AgentSpec } from './spec.js';

/** ai-sdk/tool-loop 的能力画像 */
const toolLoop: EngineCapabilities = {
  costVisibility: 'per-call',
  toolInterception: 'all',
  state: 'messages',
  suspend: 'native-approval',
  sliceControl: 'native',
  granularity: 'step',
  progress: 'step',
  streaming: true,
  structuredOutput: true,
};

/** ai-sdk/harness 的能力画像（Claude Code 一类） */
const harness: EngineCapabilities = {
  costVisibility: 'per-turn',
  toolInterception: 'host-declared-only',
  state: 'engine-session',
  suspend: 'native-approval',
  sliceControl: 'none',
  granularity: 'turn',
  progress: 'turn',
  streaming: true,
  structuredOutput: true,
};

const base = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  name: 'x',
  engine: 'e',
  ...over,
});

describe('能力—配置一致性校验（§4.4）', () => {
  it('全绿引擎不产生任何告警', () => {
    expect(assertCapabilities(base(), toolLoop).warnings).toEqual([]);
  });

  it('costVisibility=none 拒绝启动', () => {
    expect(() => assertCapabilities(base(), { ...toolLoop, costVisibility: 'none' })).toThrow(
      CapabilityError,
    );
  });

  it('costVisibility=per-turn 允许启动，但必须告警单轮内可能超支', () => {
    const { warnings } = assertCapabilities(base(), harness);
    expect(warnings.some((w) => w.includes('轮间闸门'))).toBe(true);
  });

  it('toolInterception=none + effectful 工具 → 拒绝启动', () => {
    const spec = base({ toolPolicies: { charge: { effect: 'effectful' } } });
    expect(() => assertCapabilities(spec, { ...toolLoop, toolInterception: 'none' })).toThrow(
      /幂等保护实际不存在/,
    );
  });

  it('effectful 声明在引擎内建工具上 → 拒绝启动（那个工具我们碰不到）', () => {
    const spec = base({ toolPolicies: { bash: { effect: 'effectful' } } });
    expect(() => assertCapabilities(spec, harness, { builtinTools: ['bash', 'read_file'] })).toThrow(
      /内建工具/,
    );
  });

  it('effectful 声明在我们自己的工具上 → 允许，但告警内建工具不在管控内', () => {
    const spec = base({ toolPolicies: { refund: { effect: 'effectful' } } });
    const { warnings } = assertCapabilities(spec, harness, { builtinTools: ['bash'] });
    expect(warnings.some((w) => w.includes('host-declared-only'))).toBe(true);
  });

  it('suspend=none + 声明了 approval → 拒绝启动，不留到运行期', () => {
    const spec = base({ toolPolicies: { refund: { effect: 'pure', approval: 'always' } } });
    // Codex 是 9 个适配器里唯一没有原生审批的
    const codex: EngineCapabilities = { ...harness, suspend: 'none' };
    expect(() => assertCapabilities(spec, codex)).toThrow(/不支持人工审批/);
  });

  it('sliceControl=none 告警要按最坏单轮时长设 wallClockMs', () => {
    const { warnings } = assertCapabilities(base(), harness);
    expect(warnings.some((w) => w.includes('sliceControl'))).toBe(true);
  });

  it('callback 分片与 resumePolicy=never 矛盾 → 拒绝启动', () => {
    const spec = base({ conductor: { leaseStrategy: 'callback', resumePolicy: 'never' } });
    expect(() => assertCapabilities(spec, toolLoop)).toThrow(/矛盾/);
  });

  it('lease-extend + resumePolicy=never 是唯一合法的无 journal 组合', () => {
    const spec = base({ conductor: { leaseStrategy: 'lease-extend', resumePolicy: 'never' } });
    expect(() => assertCapabilities(spec, toolLoop)).not.toThrow();
  });
});
