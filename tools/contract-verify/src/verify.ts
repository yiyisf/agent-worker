import { mkdir, writeFile } from 'node:fs/promises';
import { ConductorRest } from './rest.js';
import { Registry } from './defs.js';
import { heartbeatVariants, runHeartbeatVariant, type HeartbeatConfig } from './experiments/heartbeat.js';
import { runRetry } from './experiments/retry.js';
import { runPayload } from './experiments/payload.js';
import { runProbes } from './experiments/probes.js';
import { renderMarkdown, type VerifyReport } from './report.js';
import { startConductorContainer } from './container.js';
import { envInt, envIntList, log } from './util.js';

const ALL = ['heartbeat', 'retry', 'payload', 'probes'] as const;
type Experiment = (typeof ALL)[number];

async function main(): Promise<number> {
  const only = (process.env.ONLY?.split(',').map((s) => s.trim()) ?? [...ALL]) as Experiment[];
  const cfg: HeartbeatConfig = {
    responseTimeoutSeconds: envInt('RESPONSE_TIMEOUT_SECONDS', 10),
    heartbeatEverySeconds: envInt('HEARTBEAT_EVERY_SECONDS', 4),
    observeSeconds: envInt('OBSERVE_SECONDS', 90),
  };
  if (cfg.heartbeatEverySeconds >= cfg.responseTimeoutSeconds) {
    throw new Error('HEARTBEAT_EVERY_SECONDS 必须小于 RESPONSE_TIMEOUT_SECONDS');
  }
  if (cfg.observeSeconds < cfg.responseTimeoutSeconds * 4) {
    log(`提示：OBSERVE_SECONDS=${cfg.observeSeconds} 偏短，服务端超时检测可能来不及触发，基线可能无效。`);
  }
  const payloadSizes = envIntList('PAYLOAD_SIZES_KB', [64, 256, 1024, 3072, 5120, 10240]);

  let serverUrl = process.env.CONDUCTOR_URL;
  let stopContainer: (() => Promise<void>) | undefined;
  if (!serverUrl) {
    const image = process.env.CONDUCTOR_IMAGE;
    if (!image) throw new Error('请设置 CONDUCTOR_URL（推荐，指向非生产环境）或 CONDUCTOR_IMAGE（testcontainers 模式）');
    log(`启动容器 ${image} …`);
    const c = await startConductorContainer(image);
    serverUrl = c.url;
    stopContainer = c.stop;
  }

  const headers: Record<string, string> = {};
  if (process.env.CONDUCTOR_TOKEN) headers.Authorization = `Bearer ${process.env.CONDUCTOR_TOKEN}`;
  const rest = new ConductorRest(serverUrl, headers);
  const registry = new Registry(rest);
  const prefix = `cas_verify_${Date.now().toString(36)}`;

  const report: VerifyReport = {
    serverUrl,
    prefix,
    startedAt: new Date().toISOString(),
    heartbeatConfig: cfg,
    heartbeat: [],
    errors: [],
  };
  const fail = (experiment: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    report.errors.push({ experiment, message });
    log(`[${experiment}] 失败：${message}`);
  };

  try {
    // 连通性
    const ping = await rest.request('GET', '/metadata/taskdefs');
    if (ping.status >= 300) throw new Error(`无法访问 ${serverUrl}/metadata/taskdefs：HTTP ${ping.status}`);

    if (only.includes('heartbeat')) {
      log('== 实验 1：心跳续约（各变体并行）');
      const settled = await Promise.allSettled(
        heartbeatVariants(cfg).map((v) => runHeartbeatVariant(rest, registry, prefix, v, cfg)),
      );
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') report.heartbeat.push(s.value);
        else fail(`heartbeat:${heartbeatVariants(cfg)[i].key}`, s.reason);
      });
    }
    if (only.includes('retry')) {
      log('== 实验 2：重试 taskId');
      try {
        report.retry = await runRetry(rest, registry, prefix);
      } catch (e) {
        fail('retry', e);
      }
    }
    if (only.includes('payload')) {
      log('== 实验 3：payload 阈值');
      try {
        report.payload = await runPayload(rest, registry, prefix, payloadSizes);
      } catch (e) {
        fail('payload', e);
      }
    }
    if (only.includes('probes')) {
      log('== 附加探测');
      try {
        report.probes = await runProbes(rest, registry, prefix);
      } catch (e) {
        fail('probes', e);
      }
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    if (process.env.CLEANUP !== '0') {
      await registry.cleanup().catch((e) => fail('cleanup', e));
    }
    await mkdir('report', { recursive: true });
    const stamp = report.startedAt.replace(/[:.]/g, '-');
    await writeFile(`report/verify-${stamp}.json`, JSON.stringify(report, null, 2));
    await writeFile(`report/verify-${stamp}.md`, renderMarkdown(report));
    log(`报告已写入 report/verify-${stamp}.md 与 .json`);
    if (stopContainer) await stopContainer();
  }
  return report.errors.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  },
);
