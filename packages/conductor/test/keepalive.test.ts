import { describe, expect, it } from 'vitest';
import { assertSafeInProgressCallbackAfter, planKeepalive } from '../src/keepalive.js';

describe('planKeepalive', () => {
  it('callbackAfterSeconds 等于 responseTimeoutSeconds，默认 extend-lease', () => {
    expect(planKeepalive(120)).toEqual({
      mode: 'extend-lease',
      intervalSeconds: 48,
      callbackAfterSeconds: 120,
      maxConsecutiveFailures: 2,
    });
    expect(planKeepalive(120, 'in-progress').mode).toBe('in-progress');
  });

  it('保活间隔不低于 5 秒', () => {
    expect(planKeepalive(13).intervalSeconds).toBe(5);
  });

  it('responseTimeoutSeconds 过小时拒绝', () => {
    expect(() => planKeepalive(12)).toThrow(/至少设为 13s/);
    expect(() => planKeepalive(0)).toThrow(/正整数/);
    expect(() => planKeepalive(1.5)).toThrow(/正整数/);
  });

  it('保活间隔始终不超过 callbackAfterSeconds 的 0.4 倍', () => {
    for (let rt = 13; rt <= 600; rt++) {
      const p = planKeepalive(rt);
      expect(p.intervalSeconds).toBeLessThanOrEqual(p.callbackAfterSeconds * 0.4);
    }
  });
});

describe('assertSafeInProgressCallbackAfter（§2.3 #1 的不变量）', () => {
  const plan = planKeepalive(180);

  it('小于保活间隔时拒绝', () => {
    expect(() => assertSafeInProgressCallbackAfter(0, plan)).toThrow(/重复投递/);
    expect(() => assertSafeInProgressCallbackAfter(plan.intervalSeconds - 1, plan)).toThrow();
  });

  it('不小于保活间隔时通过', () => {
    expect(() => assertSafeInProgressCallbackAfter(plan.intervalSeconds, plan)).not.toThrow();
    expect(() => assertSafeInProgressCallbackAfter(plan.callbackAfterSeconds, plan)).not.toThrow();
  });
});
