import { describe, expect, it, vi } from 'vitest';
import { createThrottledReporter, progressFromJournal } from '@ca/core';
import type { JournalEntry, ProgressReport } from '@ca/core';
import {
  TASK_LOG_LIMITS,
  createProgressReporter,
  formatProgressLine,
  resumeSummaryLine,
} from './progress.js';

const report = (over: Partial<ProgressReport> = {}): ProgressReport => ({
  phase: 'model',
  step: 1,
  usage: { tokens: 100, costUsd: 0.001 },
  sliceIndex: 0,
  updatedAt: 0,
  ...over,
});

describe('节流（ADR-0018：低频有界，不是实时输出流）', () => {
  it('窗口内的多次进展合并成最后一条', () => {
    let clock = 0;
    const seen: ProgressReport[] = [];
    const r = createThrottledReporter((x) => seen.push(x), { intervalMs: 15_000 }, () => clock);

    r.report(report({ step: 1 })); // 首次立即放行（phase 变化）
    r.report(report({ step: 2 }));
    r.report(report({ step: 3 }));
    expect(seen).toHaveLength(1);

    r.flush(); // 分片边界把压住的最后一条吐出来
    expect(seen).toHaveLength(2);
    expect(seen[1]!.step).toBe(3);
  });

  it('phase 变化立即放行，不等窗口', () => {
    let clock = 0;
    const seen: ProgressReport[] = [];
    const r = createThrottledReporter((x) => seen.push(x), { intervalMs: 15_000 }, () => clock);
    r.report(report({ phase: 'model' }));
    r.report(report({ phase: 'tool:lookup' }));
    r.report(report({ phase: 'tool:charge' }));
    expect(seen.map((s) => s.phase)).toEqual(['model', 'tool:lookup', 'tool:charge']);
  });

  it('窗口到期后放行', () => {
    let clock = 0;
    const seen: ProgressReport[] = [];
    const r = createThrottledReporter((x) => seen.push(x), { intervalMs: 15_000 }, () => clock);
    r.report(report({ step: 1 }));
    r.report(report({ step: 2 }));
    expect(seen).toHaveLength(1);
    clock += 15_000;
    r.report(report({ step: 3 }));
    expect(seen).toHaveLength(2);
  });

  it('超过单 run 上限后只放行阶段变化', () => {
    let clock = 0;
    const seen: ProgressReport[] = [];
    const r = createThrottledReporter((x) => seen.push(x), { intervalMs: 0, maxReportsPerRun: 3 }, () => clock);
    for (let i = 0; i < 10; i++) r.report(report({ phase: 'model', step: i }));
    expect(seen).toHaveLength(3);
    // 换阶段的信息始终值得留下
    r.report(report({ phase: 'finalizing', step: 99 }));
    expect(seen).toHaveLength(4);
    expect(seen[3]!.phase).toBe('finalizing');
  });

  it('snapshot 始终是最新一条（权威通道 outputData.progress 用它）', () => {
    const r = createThrottledReporter(() => {}, { intervalMs: 15_000 });
    r.report(report({ step: 1 }));
    r.report(report({ step: 7 }));
    expect(r.snapshot()?.step).toBe(7);
  });
});

describe('日志行格式（不放 payload、不放密钥）', () => {
  it('一行结构化文本', () => {
    expect(formatProgressLine(report({ phase: 'tool:lookupPolicy', step: 3, usage: { tokens: 12400, costUsd: 0.031 }, sliceIndex: 2 }))).toBe(
      '[3] tool:lookupPolicy · 12.4k tok / $0.0310 · slice 2',
    );
  });

  it('已知总步数时显示分数', () => {
    expect(formatProgressLine(report({ step: 3, totalSteps: 12 }))).toContain('[3/12]');
  });

  it('超长内容被截断到 512 字符', () => {
    const line = formatProgressLine(report({ phase: 'x'.repeat(2000) }));
    expect(line.length).toBeLessThanOrEqual(TASK_LOG_LIMITS.maxChars);
    expect(line.endsWith('…')).toBe(true);
  });

  it('续接摘要把跨 taskId 的断档接上', () => {
    const line = resumeSummaryLine(report({ step: 5, usage: { tokens: 3400, costUsd: 0.02 }, sliceIndex: 2 }));
    expect(line).toContain('从第 5 步恢复');
    expect(line).toContain('3.4k tok');
  });
});

describe('Task Log 通道（尽力而为）', () => {
  it('单次调用不超过 10 条 —— 服务端会静默截断超出部分', async () => {
    const calls: string[][] = [];
    const r = createProgressReporter({ addLogs: (lines) => void calls.push(lines) }, { intervalMs: 0 });
    for (let i = 0; i < 25; i++) r.report(report({ phase: `p${i}`, step: i }));
    await r.drain();
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c.length).toBeLessThanOrEqual(TASK_LOG_LIMITS.maxLogsPerCall);
    expect(calls.flat()).toHaveLength(25);
  });

  it('写失败不影响主流程，只记本地日志', async () => {
    const warn = vi.fn();
    const r = createProgressReporter(
      {
        addLogs: () => {
          throw new Error('索引挂了');
        },
      },
      { intervalMs: 0, logger: { debug() {}, info() {}, warn, error() {} } },
    );
    r.report(report());
    await expect(r.drain()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('探测到 task log 索引未启用时自动关闭通道并只告警一次', async () => {
    const warn = vi.fn();
    const addLogs = vi.fn();
    const r = createProgressReporter(
      { addLogs },
      { taskLogAvailable: false, intervalMs: 0, logger: { debug() {}, info() {}, warn, error() {} } },
    );
    expect(r.taskLogEnabled).toBe(false);
    r.report(report());
    r.report(report({ phase: 'other' }));
    await r.drain();
    // 一条都不写 —— 写了也会被 NoopIndexDAO 静默丢弃，不如明确关掉
    expect(addLogs).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    // 但权威通道仍然可用
    expect(r.snapshot()).toBeDefined();
  });

  it('没有 sink 时只走权威通道，不报错', async () => {
    const r = createProgressReporter(undefined, { intervalMs: 0 });
    r.report(report());
    await expect(r.drain()).resolves.toBeUndefined();
    expect(r.taskLogEnabled).toBe(false);
    expect(r.snapshot()?.step).toBe(1);
  });
});

describe('从 journal 推导进展（不额外写 journal，避免写放大）', () => {
  const budget = { inputTokens: 30, outputTokens: 12, costUsd: 0.02, toolCalls: 1, modelCalls: 2 };

  it('数受管调用、累计用量、分片序号', () => {
    const entries: JournalEntry[] = [
      { seq: 0, kind: 'model', stepId: 'a#0', response: {}, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
      { seq: 1, kind: 'tool.result', stepId: 'b#0', tool: 'lookup', output: {} },
      { seq: 2, kind: 'slice', index: 0, state: {}, budget },
    ];
    const p = progressFromJournal(entries);
    expect(p?.step).toBe(2);
    expect(p?.sliceIndex).toBe(1);
    expect(p?.usage.tokens).toBe(42);
    expect(p?.usage.costUsd).toBeCloseTo(0.02);
  });

  it('挂起时 phase 为 suspended', () => {
    const p = progressFromJournal([
      { seq: 0, kind: 'model', stepId: 'a#0', response: {}, usage: { inputTokens: 1, outputTokens: 1 } },
      { seq: 1, kind: 'suspend', awaiting: {}, resumeToken: 't', state: {}, budget },
    ]);
    expect(p?.phase).toBe('suspended');
  });

  it('空 journal 没有进展可报', () => {
    expect(progressFromJournal([])).toBeUndefined();
  });
});
