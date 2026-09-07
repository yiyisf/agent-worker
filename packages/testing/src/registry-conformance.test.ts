/** 内存注册表必须通过与 Redis 版完全相同的一致性断言 */
import { describe, expect, it } from 'vitest';
import { MemoryRunRegistry } from '@ca/core';
import { checkRunRegistryConformance } from './registry-conformance.js';

describe('运行注册表一致性套件', () => {
  it('MemoryRunRegistry 零违规', async () => {
    const violations = await checkRunRegistryConformance({
      async create() {
        return { registry: new MemoryRunRegistry(), runId: 'task-1' };
      },
    });
    expect(violations).toEqual([]);
  });

  it('抓得住「并发 tryStart 都放行」的坏实现', async () => {
    const violations = await checkRunRegistryConformance({
      async create() {
        const inner = new MemoryRunRegistry();
        return {
          runId: 'task-1',
          registry: {
            ...inner,
            // 谁来都放行 —— 这会让同一次执行被跑多遍
            async tryStart(runId: string, owner: string) {
              await inner.tryStart(runId, owner, { orphanAfterMs: 60_000 });
              const record = (await inner.get(runId))!;
              return { ok: true as const, record, takeover: false };
            },
            heartbeat: inner.heartbeat.bind(inner),
            get: inner.get.bind(inner),
            finish: inner.finish.bind(inner),
            drop: inner.drop.bind(inner),
          },
        };
      },
    });
    expect(violations.map((v) => v.rule)).toContain('mutual-exclusion');
  });
});
