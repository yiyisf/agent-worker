/**
 * StateStore 契约套件：让内存实现与 Redis 实现受同一套断言约束。
 *
 * fencing 的正确性是 effectively-once 的最后一道闸（§5.3）。
 * 把它写成可复用的契约，而不是给每个后端各写一遍测试 ——
 * 后者的典型结局是「内存版测得很细，生产用的那个只测了 happy path」。
 */
import { FencedOutError } from '@ca/core';
import type { JournalEntry, StateStore } from '@ca/core';

export interface StoreViolation {
  rule: string;
  detail: string;
}

/** 造一个 store，并接管它的时钟以便测试租约过期 */
export type MakeStore = (now: () => number) => StateStore;

const entry = (seq: number): JournalEntry => ({
  seq,
  kind: 'resume',
  payload: { n: seq },
});

export async function checkStateStoreConformance(make: MakeStore): Promise<StoreViolation[]> {
  const violations: StoreViolation[] = [];
  const push = (rule: string, detail: string) => violations.push({ rule, detail });
  let clock = 1_000_000;
  const store = make(() => clock);
  const key = `conformance-${Math.random().toString(36).slice(2)}`;

  // ── 1. 首次抢占 ──
  const first = await store.acquire(key, 'w1', 5_000);
  if (!first) {
    push('acquire', '全新 runKey 应当能抢到租约');
    return violations;
  }
  if (first.fenceToken < 1) push('acquire', `fenceToken 应当从 1 起，实际 ${first.fenceToken}`);

  // ── 2. 未过期时别人抢不到 ──
  if (await store.acquire(key, 'w2', 5_000)) {
    push('acquire', '租约未过期时，另一个 owner 不应抢到 —— 否则会并发执行同一个 run');
  }

  // ── 3. 写入与读回（顺序必须保持） ──
  await store.appendJournal(first, [entry(0), entry(1)]);
  await store.appendJournal(first, [entry(2)]);
  const read = await store.readJournal(key);
  if (read.length !== 3 || read.map((e) => e.seq).join(',') !== '0,1,2') {
    push('journal', `读回的条目应当保持写入顺序，实际 [${read.map((e) => e.seq).join(',')}]`);
  }

  // ── 4. 续租：持有者能续，落后 fence 不能 ──
  if (!(await store.renew(first, 5_000))) push('renew', '持有当前 fence 的租约应当能续');
  if (await store.renew({ ...first, fenceToken: first.fenceToken - 1 }, 5_000)) {
    push('renew', '落后 fence 的租约不应能续');
  }

  // ── 5. 过期后被接管，fence 必须递增 ──
  clock += 60_000;
  const second = await store.acquire(key, 'w2', 5_000);
  if (!second) {
    push('acquire', '租约过期后应当能被别的 worker 接管');
    return violations;
  }
  if (second.fenceToken <= first.fenceToken) {
    push('fencing', `接管后 fenceToken 必须递增：旧 ${first.fenceToken}，新 ${second.fenceToken}`);
  }

  // ── 6. 落后 worker 的写入必须被拒（fencing 的核心）──
  let fenced = false;
  try {
    await store.appendJournal(first, [entry(99)]);
  } catch (err) {
    fenced = err instanceof FencedOutError;
    if (!fenced) push('fencing', `落后写入应当抛 FencedOutError，实际抛了 ${(err as Error)?.name}`);
  }
  if (!fenced) {
    push('fencing', '被接管后，旧 worker 的 appendJournal 必须被拒绝 —— 否则脏数据会混进 journal');
  }
  const afterFenced = await store.readJournal(key);
  if (afterFenced.some((e) => e.seq === 99)) {
    push('fencing', '被拒绝的写入不应留下任何条目');
  }

  // ── 7. release 后可立即接管 ──
  await store.release(second);
  const third = await store.acquire(key, 'w3', 5_000);
  if (!third) push('release', 'release 之后应当能被立即接管，不必等租约自然过期');

  // ── 8. dropJournal ──
  await store.dropJournal(key);
  if ((await store.readJournal(key)).length !== 0) push('dropJournal', 'dropJournal 之后 journal 应为空');

  return violations;
}
