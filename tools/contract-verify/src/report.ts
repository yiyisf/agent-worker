import { describeHeartbeat, type HeartbeatConfig, type HeartbeatResult, type HeartbeatVerdict } from './experiments/heartbeat.js';
import type { RetryResult } from './experiments/retry.js';
import type { PayloadProbe } from './experiments/payload.js';
import type { ProbeResult } from './experiments/probes.js';

export interface VerifyReport {
  serverUrl: string;
  prefix: string;
  startedAt: string;
  finishedAt?: string;
  heartbeatConfig: HeartbeatConfig;
  heartbeat: HeartbeatResult[];
  retry?: RetryResult;
  payload?: PayloadProbe[];
  probes?: ProbeResult;
  errors: Array<{ experiment: string; message: string }>;
}

const VERDICT_TEXT: Record<HeartbeatVerdict, string> = {
  SAFE: '安全：续约生效，未被重复拉取',
  DUPLICATE_DELIVERY: '危险：同一 taskId 被其他 worker 拉到',
  TIMED_OUT_AND_RETRIED: '失败：心跳未能阻止超时重试',
  BASELINE_TIMEOUT_OBSERVED: '基线有效：不发心跳会超时并重试',
  BASELINE_NO_TIMEOUT: '基线无效：观察窗口内未触发超时',
};

const yn = (b: boolean) => (b ? '是' : '否');

export function renderMarkdown(r: VerifyReport): string {
  const out: string[] = [];
  out.push('# 契约验证报告', '');
  out.push(`- 服务端：${r.serverUrl}`);
  out.push(`- 时间：${r.startedAt} → ${r.finishedAt ?? '未完成'}`);
  out.push(`- 元数据前缀：\`${r.prefix}\``);
  const c = r.heartbeatConfig;
  out.push(`- 心跳参数：responseTimeoutSeconds=${c.responseTimeoutSeconds}，心跳周期 ${c.heartbeatEverySeconds}s，观察 ${c.observeSeconds}s`, '');

  // 1. 心跳
  out.push('## 1. 心跳续约与重复派发', '');
  if (r.heartbeat.length === 0) {
    out.push('未运行或全部失败，见“错误”。', '');
  } else {
    out.push('| 变体 | 心跳次数（非 2xx） | 同一 taskId 被他人拉到 | 产生重试实例 | 原任务最终状态 | 结论 |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const h of r.heartbeat) {
      const dup = h.foreignPolls.filter((f) => f.sameTask).length;
      const retries = Math.max(h.instances.length - 1, h.foreignPolls.filter((f) => !f.sameTask).length);
      out.push(
        `| ${h.variant.label} | ${h.heartbeatsSent}（${h.heartbeatNonOk.length}） | ${dup > 0 ? `是（${dup} 次）` : '否'} | ${retries > 0 ? `是（${retries}）` : '否'} | ${h.originalFinalStatus} | ${VERDICT_TEXT[h.verdict]} |`,
      );
    }
    out.push('');
    const baseline = r.heartbeat.find((h) => h.variant.mode === 'none');
    if (baseline?.verdict === 'BASELINE_NO_TIMEOUT') {
      out.push(
        '> ⚠️ 基线未触发超时，说明观察窗口短于服务端超时检测周期，其他变体的“安全”结论不可信。请调大 `OBSERVE_SECONDS`（例如 180）后重跑。',
        '',
      );
    } else {
      const safe = r.heartbeat.filter((h) => h.verdict === 'SAFE' && h.variant.mode !== 'none');
      const unsafe = r.heartbeat.filter((h) => h.variant.mode !== 'none' && h.verdict !== 'SAFE');
      out.push('**对 SDK 的含义**（保活参数见 ADR-0024）：');
      if (safe.length) out.push(`- 可用：${safe.map((h) => describeHeartbeat(h.variant)).join('、')}`);
      if (unsafe.length) out.push(`- 不可用：${unsafe.map((h) => `${describeHeartbeat(h.variant)}（${VERDICT_TEXT[h.verdict]}）`).join('；')}`);
      const ext = r.heartbeat.find((h) => h.variant.mode === 'extend-lease');
      if (ext) out.push(`- ADR-0024 默认保活模式：${ext.verdict === 'SAFE' ? '`extend-lease`（实测通过）' : '改为 `in-progress`（extendLease 实测未通过）'}`);
      out.push('');
    }
  }

  // 2. 重试
  out.push('## 2. 重试是否生成新 taskId', '');
  if (!r.retry) {
    out.push('未运行或失败，见“错误”。', '');
  } else {
    const n = r.retry.normal;
    out.push('| 尝试 | taskId | retryCount | retriedTaskId | 上报 |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const a of n.attempts) {
      out.push(`| ${a.attempt} | \`${a.taskId}\` | ${a.retryCount ?? '-'} | ${a.retriedTaskId ? `\`${a.retriedTaskId}\`` : '-'} | ${a.action}（HTTP ${a.updateHttp}） |`);
    }
    out.push('');
    out.push(`- 每次重试 taskId 不同：**${yn(n.distinctTaskIds)}**；工作流最终状态：${n.workflowStatus}`);
    const t = r.retry.terminal;
    out.push(`- FAILED_WITH_TERMINAL_ERROR 后仍被重试：**${yn(t.retriedAfterTerminal)}**；任务状态 ${t.taskStatus}，工作流状态 ${t.workflowStatus}`);
    out.push(
      `- **对 SDK 的含义**：${
        n.distinctTaskIds
          ? 'taskId 不能作为跨重试的幂等键，采用 `workflowId:referenceTaskName` 作为任务键（与设计一致）。'
          : 'taskId 在重试间保持不变，需复核设计中“执行 ID / 任务键”的划分。'
      }`,
      '',
    );
  }

  // 3. payload
  out.push('## 3. Task output payload 阈值', '');
  if (!r.payload?.length) {
    out.push('未运行或失败，见“错误”。', '');
  } else {
    out.push('| 大小 | 上报 HTTP | 任务状态 | 已外部化 | 内联保存字节 | 失败原因 |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const p of r.payload) {
      out.push(
        `| ${p.sizeKB} KB | ${p.updateHttp} | ${p.taskStatus} | ${p.externalOutputPayloadStoragePath ? '是' : '否'} | ${p.storedInlineBytes ?? '-'} | ${(p.reasonForIncompletion ?? (p.updateHttp >= 300 ? p.updateBody : '')).replace(/\|/g, '/').slice(0, 120) || '-'} |`,
      );
    }
    out.push('');
    const firstBad = r.payload.find((p) => p.updateHttp >= 300 || p.taskStatus !== 'COMPLETED');
    const firstExt = r.payload.find((p) => p.externalOutputPayloadStoragePath);
    out.push(`- 首个被外部化的档位：${firstExt ? `${firstExt.sizeKB} KB` : '无'}`);
    out.push(`- 首个失败或被拒的档位：${firstBad ? `${firstBad.sizeKB} KB` : '无'}`);
    out.push('- **对 SDK 的含义**：`maxOutputBytes` 默认值应低于首个外部化档位，并留出信封其他字段的余量。', '');
  }

  // 4. 其他探测
  out.push('## 4. 其他探测', '');
  if (!r.probes) {
    out.push('未运行或失败，见“错误”。', '');
  } else {
    const p = r.probes;
    out.push(`- Task Log 写入 HTTP ${p.taskLog.writeHttp}，读取 HTTP ${p.taskLog.readHttp}，读回一致：**${yn(p.taskLog.roundTrip)}**`);
    out.push(
      `- TaskDef schema 字段：注册 HTTP ${p.schema.registerHttp}，被持久化的字段：${p.schema.persistedKeys.length ? p.schema.persistedKeys.join('、') : '无'}（仅说明字段被保存，不代表服务端会校验）`,
      '',
    );
  }

  out.push('## 错误', '');
  out.push(r.errors.length ? r.errors.map((e) => `- ${e.experiment}：${e.message}`).join('\n') : '无', '');
  return out.join('\n');
}
