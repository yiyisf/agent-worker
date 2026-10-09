import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agentTaskFailureOutputSchema,
  agentTaskInputSchema,
  agentTaskInterimOutputSchema,
  agentTaskOutputSchema,
} from '../src/envelope/schemas.js';
import { interpretEngineOutput } from '../src/envelope/engine-output.js';
import { artifact, progress, run, usage } from './fixtures.js';

const input = agentTaskInputSchema(z.object({ docUrl: z.string().url() }));
const output = agentTaskOutputSchema(z.object({ summary: z.string() }), { summaryMaxChars: 20 });

describe('AgentTaskInput', () => {
  it('接受最小合法输入', () => {
    expect(input.safeParse({ schemaVersion: '1', payload: { docUrl: 'https://x.test/a' } }).success).toBe(true);
  });

  it('接受 handoff 与执行参数', () => {
    const r = input.safeParse({
      schemaVersion: '1',
      payload: { docUrl: 'https://x.test/a' },
      context: { handoffs: [{ fromRef: 'review', summary: 'ok', artifacts: [artifact] }] },
      execution: { maxSteps: 10, budget: { maxCostUsd: 0.5 } },
    });
    expect(r.success).toBe(true);
  });

  it('拒绝错误的 schemaVersion', () => {
    expect(input.safeParse({ schemaVersion: '2', payload: { docUrl: 'https://x.test/a' } }).success).toBe(false);
  });

  it('拒绝顶层未知字段（捕获 workflow 映射拼写错误）', () => {
    expect(input.safeParse({ schemaVersion: '1', payload: { docUrl: 'https://x.test/a' }, handoffs: [] }).success).toBe(false);
  });

  it('拒绝不合法的 payload', () => {
    expect(input.safeParse({ schemaVersion: '1', payload: { docUrl: 'not-a-url' } }).success).toBe(false);
  });
});

describe('AgentTaskOutput', () => {
  const base = { schemaVersion: '1', summary: 'done', artifacts: [], usage, run };

  it('completed 必须带 result', () => {
    expect(output.safeParse({ ...base, outcome: 'completed', result: { summary: 's' } }).success).toBe(true);
    expect(output.safeParse({ ...base, outcome: 'completed' }).success).toBe(false);
  });

  it('needs_approval 必须带 request.proposal', () => {
    expect(output.safeParse({ ...base, outcome: 'needs_approval', request: { reason: 'r' } }).success).toBe(false);
    expect(
      output.safeParse({ ...base, outcome: 'needs_approval', request: { reason: 'r', proposal: { op: 'restart' } } }).success,
    ).toBe(true);
  });

  it('needs_input 必须带 request.question', () => {
    expect(output.safeParse({ ...base, outcome: 'needs_input', request: { reason: 'r' } }).success).toBe(false);
    expect(output.safeParse({ ...base, outcome: 'needs_input', request: { reason: 'r', question: 'q?' } }).success).toBe(true);
  });

  it('escalated 必须带 request', () => {
    expect(output.safeParse({ ...base, outcome: 'escalated' }).success).toBe(false);
  });

  it('summary 超长时拒绝', () => {
    expect(output.safeParse({ ...base, summary: 'x'.repeat(21), outcome: 'completed', result: { summary: 's' } }).success).toBe(false);
  });

  it('拒绝非法 sha256', () => {
    const bad = { ...artifact, sha256: 'xyz' };
    expect(output.safeParse({ ...base, artifacts: [bad], outcome: 'completed', result: { summary: 's' } }).success).toBe(false);
  });

  it('run 必须带 engine 与 specHash（§7.2 可追溯）', () => {
    const { specHash: _, ...noHash } = run;
    expect(output.safeParse({ ...base, run: noHash, outcome: 'completed', result: { summary: 's' } }).success).toBe(false);
  });
});

describe('AgentTaskFailureOutput', () => {
  it('接受失败信封，含 FENCED', () => {
    const r = agentTaskFailureOutputSchema.safeParse({
      schemaVersion: '1',
      error: { code: 'FENCED', message: 'fenced out', retryable: false },
      usage,
      run,
    });
    expect(r.success).toBe(true);
  });
});

describe('AgentTaskInterimOutput', () => {
  it('分片交还时只带 progress', () => {
    expect(agentTaskInterimOutputSchema.safeParse({ schemaVersion: '1', progress }).success).toBe(true);
    expect(agentTaskInterimOutputSchema.safeParse({ schemaVersion: '1', progress, result: {} }).success).toBe(false);
  });
});

describe('interpretEngineOutput', () => {
  it('普通输出视为 completed', () => {
    expect(interpretEngineOutput({ summary: 's' })).toEqual({
      outcome: 'completed',
      result: { summary: 's' },
      summary: '',
      artifacts: [],
    });
    expect(interpretEngineOutput('plain text').result).toBe('plain text');
  });

  it('含 outcome 的对象按信封字段解释', () => {
    const r = interpretEngineOutput({
      outcome: 'needs_approval',
      summary: '需要批准重启',
      request: { reason: 'r', proposal: { op: 'restart' } },
    });
    expect(r).toEqual({
      outcome: 'needs_approval',
      summary: '需要批准重启',
      artifacts: [],
      request: { reason: 'r', proposal: { op: 'restart' } },
    });
  });

  it('非法 outcome 抛错', () => {
    expect(() => interpretEngineOutput({ outcome: 'done' })).toThrow(/outcome 不合法/);
  });
});
