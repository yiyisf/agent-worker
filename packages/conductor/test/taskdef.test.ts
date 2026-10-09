import { describe, expect, it, vi } from 'vitest';
import { deriveTaskDef, diffTaskDefs } from '../src/taskdef.js';
import { spec } from './fixtures.js';

describe('deriveTaskDef', () => {
  it('callback 策略按 §6.6 推导超时', () => {
    const d = deriveTaskDef(spec());
    expect(d.timeoutSeconds).toBe(720); // 600 × 1.2
    expect(d.responseTimeoutSeconds).toBe(180); // max(30, 60 × 3)
    expect(d.retryCount).toBe(2);
    expect(d.retryLogic).toBe('EXPONENTIAL_BACKOFF');
    expect(d.retryDelaySeconds).toBe(5);
    expect(d.timeoutPolicy).toBe('RETRY');
  });

  it('sliceMs 很小时 responseTimeoutSeconds 不低于 30s 下限', () => {
    expect(deriveTaskDef(spec({ limits: { wallClockMs: 600_000, sliceMs: 5_000 } })).responseTimeoutSeconds).toBe(30);
  });

  it('lease-extend 策略 responseTimeoutSeconds = 60', () => {
    const s = spec();
    expect(deriveTaskDef({ ...s, conductor: { ...s.conductor!, leaseStrategy: 'lease-extend' } }).responseTimeoutSeconds).toBe(60);
  });

  it('显式覆盖低于下限时夹到 30s 并告警', () => {
    const s = spec();
    const onWarning = vi.fn();
    const d = deriveTaskDef({ ...s, conductor: { ...s.conductor!, responseTimeoutSeconds: 10 } }, { onWarning });
    expect(d.responseTimeoutSeconds).toBe(30);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('已夹到 30s'));
  });

  it('带上 nameCn 与信封键', () => {
    const d = deriveTaskDef(spec());
    expect(d.nameCn).toBe('文档摘要 Agent');
    expect(d.inputKeys).toContain('payload');
    expect(d.outputKeys).toEqual(expect.arrayContaining(['outcome', 'progress', 'error']));
  });

  it('缺少 nameCn 时拒绝，requireNameCn: false 时放行', () => {
    const s = spec();
    const noName = { ...s, conductor: { ...s.conductor!, nameCn: '  ' } };
    expect(() => deriveTaskDef(noName)).toThrow(/nameCn/);
    expect(deriveTaskDef(noName, { requireNameCn: false })).not.toHaveProperty('nameCn');
  });

  it('非法 taskType 时拒绝', () => {
    const s = spec();
    expect(() => deriveTaskDef({ ...s, conductor: { ...s.conductor!, taskType: 'agent-summarize' } })).toThrow(/taskType/);
  });

  it('缺少 wallClockMs 或 ownerEmail 时拒绝', () => {
    expect(() => deriveTaskDef(spec({ limits: {} }))).toThrow(/wallClockMs/);
    const s = spec();
    const { ownerEmail: _, ...noOwner } = s.conductor!;
    expect(() => deriveTaskDef({ ...s, conductor: noOwner })).toThrow(/ownerEmail/);
    expect(deriveTaskDef({ ...s, conductor: noOwner }, { ownerEmail: 'x@example.com' }).ownerEmail).toBe('x@example.com');
  });

  it('retryCount 不可为 0', () => {
    const s = spec();
    expect(() => deriveTaskDef({ ...s, conductor: { ...s.conductor!, retry: { count: 0 } } })).toThrow(/retryCount/);
  });

  it('短任务 timeoutSeconds 必须大于 responseTimeoutSeconds', () => {
    expect(() => deriveTaskDef(spec({ limits: { wallClockMs: 60_000 } }))).toThrow(/responseTimeoutSeconds/);
  });

  it('透传限流与并发上限', () => {
    const s = spec();
    const d = deriveTaskDef({
      ...s,
      conductor: { ...s.conductor!, concurrentExecLimit: 4, rateLimit: { perFrequency: 10, frequencyInSeconds: 60 } },
    });
    expect(d).toMatchObject({ concurrentExecLimit: 4, rateLimitPerFrequency: 10, rateLimitFrequencyInSeconds: 60 });
  });
});

describe('diffTaskDefs', () => {
  it('报告缺失与字段漂移', () => {
    const local = deriveTaskDef(spec());
    expect(diffTaskDefs([local], [])).toEqual([{ name: local.name, field: '*', local, remote: undefined }]);
    expect(diffTaskDefs([local], [{ ...local, extraServerField: 1 }])).toEqual([]);
    expect(diffTaskDefs([local], [{ ...local, responseTimeoutSeconds: 60 }])).toEqual([
      { name: local.name, field: 'responseTimeoutSeconds', local: 180, remote: 60 },
    ]);
  });
});
