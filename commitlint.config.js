export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', [
      'core', 'conductor', 'engine-ai-sdk', 'engine-harness', 'engine-custom', 'engine-pi-durable',
      'memory', 'observability', 'testing', 'cli', 'contract-verify',
      'examples', 'docs', 'ci', 'repo', 'deps',
    ]],
  },
};
