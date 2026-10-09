import { z } from 'zod';
import {
  AGENT_ERROR_CODES,
  ARTIFACT_KINDS,
  OUTCOMES,
  SCHEMA_VERSION,
  STOP_REASONS,
} from './types.js';

export const DEFAULT_SUMMARY_MAX_CHARS = 2000;

export const artifactRefSchema = z
  .object({
    uri: z.string().min(1),
    kind: z.enum(ARTIFACT_KINDS),
    name: z.string().min(1),
    mediaType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 必须是 64 位小写十六进制'),
    description: z.string().optional(),
  })
  .strict();

export const handoffSchema = z
  .object({
    fromRef: z.string().min(1),
    summary: z.string(),
    artifacts: z.array(artifactRefSchema),
    result: z.unknown().optional(),
  })
  .strict();

export const executionOverridesSchema = z
  .object({
    model: z.string().min(1).optional(),
    reasoning: z.enum(['low', 'medium', 'high']).optional(),
    maxSteps: z.number().int().positive().optional(),
    budget: z
      .object({
        maxTokens: z.number().int().positive().optional(),
        maxCostUsd: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const traceContextSchema = z
  .object({
    traceparent: z.string().optional(),
    tenantId: z.string().optional(),
    correlationId: z.string().optional(),
  })
  .strict();

/** 入参信封：顶层未知字段会被拒绝，以便尽早发现 workflow 映射中的拼写错误 */
export function agentTaskInputSchema<P extends z.ZodType>(payload: P) {
  return z
    .object({
      schemaVersion: z.literal(SCHEMA_VERSION),
      payload,
      instructions: z.string().optional(),
      context: z
        .object({
          handoffs: z.array(handoffSchema).optional(),
          artifacts: z.array(artifactRefSchema).optional(),
        })
        .strict()
        .optional(),
      execution: executionOverridesSchema.optional(),
      trace: traceContextSchema.optional(),
    })
    .strict();
}

export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

export const runInfoSchema = z
  .object({
    runId: z.string().min(1),
    agent: z.string().min(1),
    engine: z.string().min(1),
    model: z.string().min(1),
    specHash: z.string().min(1),
    steps: z.number().int().nonnegative(),
    slices: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    resumed: z.boolean(),
    compactions: z.number().int().nonnegative().optional(),
    stopReason: z.enum(STOP_REASONS),
  })
  .strict();

export const agentErrorSchema = z
  .object({
    code: z.enum(AGENT_ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  })
  .strict();

export const agentTaskRequestSchema = z
  .object({
    reason: z.string().min(1),
    question: z.string().optional(),
    proposal: z.unknown().optional(),
  })
  .strict();

/** 与 @ca/core 的 ProgressReport 对应（§10.4） */
export const progressReportSchema = z
  .object({
    phase: z.string().min(1),
    step: z.number().int().nonnegative(),
    totalSteps: z.number().int().positive().optional(),
    usage: z.object({ tokens: z.number().nonnegative(), costUsd: z.number().nonnegative() }).strict(),
    sliceIndex: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export interface OutputSchemaOptions {
  summaryMaxChars?: number;
}

/** 成功信封：按 outcome 校验必带字段 */
export function agentTaskOutputSchema<R extends z.ZodType>(result: R, opts: OutputSchemaOptions = {}) {
  const summaryMax = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  return z
    .object({
      schemaVersion: z.literal(SCHEMA_VERSION),
      outcome: z.enum(OUTCOMES),
      result: result.optional(),
      summary: z.string().max(summaryMax),
      artifacts: z.array(artifactRefSchema),
      request: agentTaskRequestSchema.optional(),
      usage: usageSchema,
      run: runInfoSchema,
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.outcome === 'completed') {
        if (v.result === undefined) {
          ctx.addIssue({ code: 'custom', path: ['result'], message: 'outcome=completed 时 result 必填' });
        }
        return;
      }
      if (!v.request) {
        ctx.addIssue({ code: 'custom', path: ['request'], message: `outcome=${v.outcome} 时 request 必填` });
        return;
      }
      if (v.outcome === 'needs_approval' && v.request.proposal === undefined) {
        ctx.addIssue({ code: 'custom', path: ['request', 'proposal'], message: 'needs_approval 必须带 proposal' });
      }
      if (v.outcome === 'needs_input' && !v.request.question) {
        ctx.addIssue({ code: 'custom', path: ['request', 'question'], message: 'needs_input 必须带 question' });
      }
    });
}

export const agentTaskFailureOutputSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    error: agentErrorSchema,
    summary: z.string().optional(),
    usage: usageSchema,
    run: runInfoSchema,
  })
  .strict();

export const agentTaskInterimOutputSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    progress: progressReportSchema,
  })
  .strict();

/** 生成 TaskDef inputKeys / outputKeys（§6.6） */
export const ENVELOPE_INPUT_KEYS = ['schemaVersion', 'payload', 'instructions', 'context', 'execution', 'trace'] as const;
export const ENVELOPE_OUTPUT_KEYS = [
  'schemaVersion',
  'outcome',
  'result',
  'summary',
  'artifacts',
  'request',
  'usage',
  'run',
  'error',
  'progress',
] as const;
