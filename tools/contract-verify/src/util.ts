export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`环境变量 ${name} 不是整数：${v}`);
  return n;
}

export function envIntList(name: string, fallback: number[]): number[] {
  const v = process.env[name];
  return v ? v.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n)) : fallback;
}

export function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
