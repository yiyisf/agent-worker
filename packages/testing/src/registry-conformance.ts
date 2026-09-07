/**
 * 运行注册表一致性套件。
 *
 * 内存版与 Redis 版共用同一份断言 —— 注册表是异步化模型的正确性支点，
 * 两种实现在并发与接管语义上必须完全一致（ADR-0019/0021）。
 */
import type { RunRegistry } from '@ca/core';

export interface RegistryViolation {
  rule: string;
  detail: string;
}

export interface RegistryFixture {
  /** 每次调用返回一个干净的注册表实例（键空间互不干扰） */
  create(): Promise<{ registry: RunRegistry; runId: string }>;
}

const OPTS = { orphanAfterMs: 60_000 };

export async function checkRunRegistryConformance(
  fixture: RegistryFixture,
): Promise<RegistryViolation[]> {
  const v: RegistryViolation[] = [];
  const push = (rule: string, detail: string) => v.push({ rule, detail });

  // ── 规则 1：首次 tryStart 取得所有权 ──
  {
    const { registry, runId } = await fixture.create();
    const first = await registry.tryStart(runId, 'w1', OPTS);
    if (!first.ok || first.takeover) {
      push('first-start', `首次 tryStart 应当取得所有权且 takeover=false，实际 ${JSON.stringify(first)}`);
    }
  }

  // ── 规则 2：并发 tryStart 只有一个成功（60 秒 unack 窗口下这是真实场景）──
  {
    const { registry, runId } = await fixture.create();
    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((w) => registry.tryStart(runId, w, OPTS)),
    );
    const winners = results.filter((r) => r.ok);
    if (winners.length !== 1) {
      push(
        'mutual-exclusion',
        `5 个 worker 并发 tryStart，应当只有 1 个取得所有权，实际 ${winners.length} 个。` +
          `多于 1 个意味着同一次执行会被跑多遍、重复付费。`,
      );
    }
    const running = results.filter((r) => !r.ok && r.reason === 'running');
    if (running.length !== results.length - winners.length) {
      push('mutual-exclusion', '未取得所有权的调用应当一律返回 reason=running');
    }
  }

  // ── 规则 3：心跳只有当前 owner 能刷；被接管后旧 owner 被拒 ──
  {
    const { registry, runId } = await fixture.create();
    await registry.tryStart(runId, 'w1', OPTS);
    if (!(await registry.heartbeat(runId, 'w1'))) {
      push('heartbeat', 'owner 自己的心跳应当成功');
    }
    if (await registry.heartbeat(runId, 'w2')) {
      push('heartbeat', '非 owner 的心跳必须被拒绝，否则失联判定会失效');
    }
  }

  // ── 规则 4：失联后可被接管，attempts 递增 ──
  {
    const { registry, runId } = await fixture.create();
    await registry.tryStart(runId, 'w1', { orphanAfterMs: 0 });
    await new Promise((r) => setTimeout(r, 5));
    const taken = await registry.tryStart(runId, 'w2', { orphanAfterMs: 0 });
    if (!taken.ok || !taken.takeover) {
      push('takeover', `心跳过期后应当可被接管且 takeover=true，实际 ${JSON.stringify(taken)}`);
    } else if (taken.record.attempts !== 2) {
      push('takeover', `接管后 attempts 应为 2，实际 ${taken.record.attempts}`);
    }
  }

  // ── 规则 5：接管次数用尽后判失败，不无限重启 ──
  {
    const { registry, runId } = await fixture.create();
    const opts = { orphanAfterMs: 0, maxAttempts: 1 };
    await registry.tryStart(runId, 'w1', opts);
    await new Promise((r) => setTimeout(r, 5));
    const next = await registry.tryStart(runId, 'w2', opts);
    if (next.ok || next.reason !== 'settled' || next.record.status !== 'failed') {
      push('max-attempts', `maxAttempts 用尽后应当返回 settled+failed，实际 ${JSON.stringify(next)}`);
    }
  }

  // ── 规则 6：终态可读；非 owner 写终态被拒 ──
  {
    const { registry, runId } = await fixture.create();
    await registry.tryStart(runId, 'w1', OPTS);
    if (await registry.finish(runId, 'w2', { status: 'done', result: 'stale' })) {
      push('finish-ownership', '非 owner 写终态必须被拒绝，否则被接管的旧宿主会覆盖新结果');
    }
    if (!(await registry.finish(runId, 'w1', { status: 'done', result: { answer: 42 } }))) {
      push('finish-ownership', 'owner 写终态应当成功');
    }
    const after = await registry.tryStart(runId, 'w3', OPTS);
    if (after.ok || after.reason !== 'settled') {
      push('settled', `终态之后 tryStart 应当返回 settled，实际 ${JSON.stringify(after)}`);
    } else if (JSON.stringify(after.record.result) !== JSON.stringify({ answer: 42 })) {
      push('settled', `终态记录应当带回结果，实际 ${JSON.stringify(after.record.result)}`);
    }
  }

  // ── 规则 7：drop 之后同 runId 可以重新开始 ──
  {
    const { registry, runId } = await fixture.create();
    await registry.tryStart(runId, 'w1', OPTS);
    await registry.finish(runId, 'w1', { status: 'done', result: 1 });
    await registry.drop(runId);
    if (await registry.get(runId)) push('drop', 'drop 之后 get 应当返回 undefined');
    if (!(await registry.tryStart(runId, 'w1', OPTS)).ok) {
      push('drop', 'drop 之后同 runId 应当可以重新取得所有权');
    }
  }

  return v;
}
