// 分层依赖规则见 docs/architecture.md §3.2 的四条结构性约束与 ADR-0006
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const OFFICIAL_SDK = '@io-orkes/conductor-javascript';
const officialSdk = { name: OFFICIAL_SDK, message: '只有 @ca/conductor 可以引用官方 Conductor SDK（ADR-0006）' };

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 契约声明大量使用仅类型的参数与占位导出
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 除桥接层与契约验证工具外，任何包都不得直接依赖官方 SDK
    files: ['**/*.ts'],
    ignores: ['packages/conductor/**', 'tools/contract-verify/**'],
    rules: { 'no-restricted-imports': ['error', { paths: [officialSdk] }] },
  },
  {
    // @ca/core 不依赖任何 Agent SDK，也不依赖 Conductor（§3.2 约束 1）
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [officialSdk],
        patterns: [
          { group: ['@ca/*'], message: '@ca/core 是最底层，不得依赖其他 @ca 包' },
          { group: ['ai', '@ai-sdk/*'], message: '@ca/core 不依赖任何 Agent SDK（ADR-0011）' },
        ],
      }],
    },
  },
  {
    // 引擎适配层与 Conductor 无关（§3.2 约束 4）
    files: ['packages/engine-*/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [officialSdk],
        patterns: [{ group: ['@ca/conductor', '@ca/conductor/*'], message: '引擎适配层不得依赖 Conductor 桥接层' }],
      }],
    },
  },
);
