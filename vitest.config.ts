import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    // 测试直接跑源码，不依赖先构建 dist
    alias: {
      '@ca/core/testkit': r('./packages/core/src/testkit.ts'),
      '@ca/core': r('./packages/core/src/index.ts'),
      '@ca/testing': r('./packages/testing/src/index.ts'),
      '@ca/memory': r('./packages/memory/src/index.ts'),
      '@ca/conductor': r('./packages/conductor/src/index.ts'),
      '@ca/engine-ai-sdk': r('./packages/engine-ai-sdk/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'examples/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
