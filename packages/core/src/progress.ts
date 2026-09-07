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
 * 异步化之后进展有了新的关键作用：它同时是**运行还活着**的证据。
 * 后台运行每产生一次进展就刷新一次注册表心跳，callback 据此判断宿主是否失联（ADR-0021）。
 */

export interface ProgressReport {
  /** 语义化阶段名，如 'model' | 'tool:lookupOrder' | 'done' */
  phase: string;
  /** 已完成的受管调用数 */
  step: number;
  /** 若可预知（plan-execute 类引擎）才有 */
  totalSteps?: number;
  usage: { tokens: number; costUsd: number };
  updatedAt: number;
}

export interface ProgressOptions {
  /** 节流窗口，默认 15_000；phase 变化时立即放行（leading edge），两者取或 */
  intervalMs?: number;
  /** 单个 run 的上报总量上限，默认 200；超限后只放行阶段变化 */
  maxReportsPerRun?: number;
}

export interface ProgressReporter {
  /** 由受管入口调用；内部节流合并 */
  report(r: ProgressReport): void;
  /** 取当前快照，写进 outputData.progress（权威通道，零额外请求） */
  snapshot(): ProgressReport | undefined;
  /** 强制吐出被节流压住的最后一条 */
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
