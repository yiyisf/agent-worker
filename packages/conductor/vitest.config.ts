import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // 只统计已实现的模块；其余文件仍为契约声明
    coverage: {
      provider: 'v8',
      include: ['src/envelope/**', 'src/errors.ts', 'src/keepalive.ts', 'src/taskdef.ts', 'src/connection.ts', 'src/metadata/**'],
      thresholds: { lines: 80, functions: 80, branches: 75 },
    },
  },
});
