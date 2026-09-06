/**
 * 进展反馈，见 docs/architecture.md §10.4 与 ADR-0018。
 *
 * ⚠️ 这是**进展**，不是执行过程的实时输出流。三者通道不同：
 *   实时输出（token delta / 工具入参出参）→ StreamSink，高频无界
 *   进展（到第几步、在做什么、累计成本）→ 本模块，低频有界
 *   最终结果                              → outputData，一次
 * 把 token 流写进 task log 会瞬间打爆服务端，且不是编排引擎该消费的东西 ——
 * 编排引擎要的是「它还活着、走到哪了」，不是「它说了什么」。
 *
 * 本文件只做与宿主无关的节流与聚合；真正往 Conductor 写是 @ca/conductor 的事。
 */
import type { JournalEntry } from './journal.js';

export interface ProgressReport {
  /** 语义化阶段名，由引擎适配器映射，如 'planning' | 'tool:lookupPolicy' | 'finalizing' */
  phase: string;
  /** 已完成的受管调用数 */
  step: number;
  /** 若可预知（plan-execute 类引擎）才有 */
  totalSteps?: number;
  usage: { tokens: number; costUsd: number };
  sliceIndex: number;
  updatedAt: number;
}

export interface ProgressOptions {
  /** 节流窗口，默认 15_000；phase 变化时立即写一次（leading edge），两者取或 */
  intervalMs?: number;
  /** 单个 run 的上报总量上限，默认 200；超限后只写阶段变化 */
  maxReportsPerRun?: number;
}

export interface ProgressReporter {
  /** 由受管入口与分片边界调用；内部节流合并 */
  report(r: ProgressReport): void;
  /** 分片交还时取当前快照，写进 outputData.progress（权威通道，零额外请求） */
  snapshot(): ProgressReport | undefined;
  /** 分片边界强制吐出被节流压住的最后一条 */
  flush(): void;
}

export const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;
export const DEFAULT_MAX_REPORTS_PER_RUN = 200;

/**
 * 节流器：窗口内多次进展合并成最后一条，phase 变化则立即放行。
 *
 * 总量上限之后只放行阶段变化 —— 一个跑很久的 Agent 不该把 task log 刷满，
 * 但「它换阶段了」这种信息始终值得留下。
 */
export function createThrottledReporter(
  emit: (r: ProgressReport) => void,
  opts: ProgressOptions = {},
  now: () => number = Date.now,
): ProgressReporter {
  const intervalMs = opts.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const maxReports = opts.maxReportsPerRun ?? DEFAULT_MAX_REPORTS_PER_RUN;

  let last: ProgressReport | undefined;
  let pending: ProgressReport | undefined;
  let lastEmitAt = -Infinity;
  let lastPhase: string | undefined;
  let emitted = 0;

  const doEmit = (r: ProgressReport): void => {
    emit(r);
    emitted += 1;
    lastEmitAt = now();
    lastPhase = r.phase;
    pending = undefined;
  };

  return {
    report(r: ProgressReport): void {
      last = r;
      const phaseChanged = r.phase !== lastPhase;
      if (emitted >= maxReports && !phaseChanged) {
        pending = r;
        return;
      }
      if (phaseChanged || now() - lastEmitAt >= intervalMs) doEmit(r);
      else pending = r;
    },
    snapshot(): ProgressReport | undefined {
      return last;
    },
    flush(): void {
      if (pending) doEmit(pending);
    },
  };
}

/**
 * 从 journal 还原进展。
 *
 * ADR-0018 原本写的是「进展同时写 journal」，实现时改为**从已有条目推导** ——
 * 已完成的受管调用数与累计用量本来就在 journal 里，再写一份纯属重复，
 * 白白加重 §15.3 第 3 条关心的写放大。跨 taskId 重试时的续接摘要即由此产生。
 */
export function progressFromJournal(entries: readonly JournalEntry[]): ProgressReport | undefined {
  if (entries.length === 0) return undefined;
  let step = 0;
  let sliceIndex = 0;
  let tokens = 0;
  let costUsd = 0;
  let phase = 'resumed';
  let updatedAt = 0;

  for (const e of entries) {
    if (e.kind === 'model') {
      step += 1;
      tokens += e.usage.inputTokens + e.usage.outputTokens;
      costUsd += e.usage.costUsd ?? 0;
      phase = 'model';
    } else if (e.kind === 'tool.result' || e.kind === 'tool.error') {
      step += 1;
      phase = `tool:${e.tool}`;
    } else if (e.kind === 'slice') {
      sliceIndex = e.index + 1;
      tokens = e.budget.inputTokens + e.budget.outputTokens;
      costUsd = e.budget.costUsd;
      updatedAt = Math.max(updatedAt, 0);
    } else if (e.kind === 'suspend') {
      phase = 'suspended';
      tokens = e.budget.inputTokens + e.budget.outputTokens;
      costUsd = e.budget.costUsd;
    }
  }

  return { phase, step, usage: { tokens, costUsd }, sliceIndex, updatedAt };
}
