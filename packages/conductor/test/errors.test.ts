import { describe, expect, it } from 'vitest';
import type { AgentErrorCode } from '../src/envelope/types.js';
import { agentError, reasonForIncompletion, toConductorStatus, type ConductorFinalStatus } from '../src/errors.js';

const cases: Array<[AgentErrorCode, ConductorFinalStatus]> = [
  ['MODEL_RATE_LIMIT', 'FAILED'],
  ['TIMEOUT', 'FAILED'],
  ['INVALID_OUTPUT', 'FAILED'],
  ['INVALID_INPUT', 'FAILED_WITH_TERMINAL_ERROR'],
  ['BUDGET_EXCEEDED', 'FAILED_WITH_TERMINAL_ERROR'],
  ['CANCELLED', 'FAILED_WITH_TERMINAL_ERROR'],
  ['FENCED', 'FAILED_WITH_TERMINAL_ERROR'],
];

describe('错误到 Conductor 状态的映射', () => {
  it('无错误为 COMPLETED', () => {
    expect(toConductorStatus(undefined)).toBe('COMPLETED');
  });

  it.each(cases)('%s -> %s', (code, status) => {
    expect(toConductorStatus(agentError(code, 'x'))).toBe(status);
  });

  it('可按工具覆盖可重试性', () => {
    expect(toConductorStatus(agentError('TOOL_FAILED', 'x', undefined, false))).toBe('FAILED_WITH_TERMINAL_ERROR');
  });

  it('details 仅在提供时出现', () => {
    expect(agentError('INTERNAL', 'x')).not.toHaveProperty('details');
    expect(agentError('INTERNAL', 'x', { a: 1 }).details).toEqual({ a: 1 });
  });

  it('reasonForIncompletion 截断', () => {
    const r = reasonForIncompletion(agentError('INTERNAL', 'y'.repeat(1000)), 50);
    expect(r).toHaveLength(50);
    expect(r.startsWith('INTERNAL: ')).toBe(true);
    expect(reasonForIncompletion(agentError('INTERNAL', 'short'))).toBe('INTERNAL: short');
  });
});
