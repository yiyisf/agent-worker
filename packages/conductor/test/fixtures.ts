import type { AgentSpec } from '@ca/core';
import type { RunInfo, Usage } from '../src/envelope/types.js';

export const usage: Usage = { inputTokens: 100, outputTokens: 20, toolCalls: 1 };
export const run: RunInfo = {
  runId: 'r1',
  agent: 'summarize',
  engine: 'ai-sdk/tool-loop',
  model: 'anthropic/test',
  specHash: 'sha256:abc',
  steps: 3,
  slices: 1,
  durationMs: 1200,
  attempt: 0,
  resumed: false,
  stopReason: 'done',
};
export const artifact = {
  uri: 's3://agent-artifacts/v1/a.md',
  kind: 'report' as const,
  name: 'a.md',
  mediaType: 'text/markdown',
  sizeBytes: 10,
  sha256: 'a'.repeat(64),
};
export const progress = {
  phase: 'tool:lookupPolicy',
  step: 3,
  usage: { tokens: 12400, costUsd: 0.031 },
  sliceIndex: 2,
  updatedAt: 1_760_000_000_000,
};

export function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'summarize',
    engine: 'ai-sdk/tool-loop',
    limits: { wallClockMs: 10 * 60_000 },
    conductor: { taskType: 'agent_summarize_doc', nameCn: '文档摘要 Agent', ownerEmail: 'team@example.com' },
    ...overrides,
  };
}
