/**
 * 引擎 done.output → 信封字段的约定，见 ADR-0020「引擎输出到信封的约定」。
 *
 * 引擎输出若是含 outcome 字段的对象，按 { outcome, result?, summary?, request?, artifacts? } 解释；
 * 否则视为 { outcome: 'completed', result: output }。解释结果仍需经 agentTaskOutputSchema 校验。
 */
import type { JsonValue } from '@ca/core';
import { OUTCOMES, type AgentTaskOutput, type Outcome } from './types.js';

export type InterpretedOutput = Pick<AgentTaskOutput<unknown>, 'outcome' | 'summary' | 'artifacts'> &
  Partial<Pick<AgentTaskOutput<unknown>, 'result' | 'request'>>;

const isOutcome = (v: unknown): v is Outcome => typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v);

export function interpretEngineOutput(output: JsonValue): InterpretedOutput {
  if (output !== null && typeof output === 'object' && !Array.isArray(output) && 'outcome' in output) {
    const { outcome, result, summary, request, artifacts } = output;
    if (!isOutcome(outcome)) {
      throw new Error(`引擎输出的 outcome 不合法：${JSON.stringify(outcome)}，应为 ${OUTCOMES.join(' | ')}`);
    }
    return {
      outcome,
      summary: typeof summary === 'string' ? summary : '',
      artifacts: Array.isArray(artifacts) ? (artifacts as unknown as InterpretedOutput['artifacts']) : [],
      ...(result === undefined ? {} : { result }),
      ...(request === undefined ? {} : { request: request as unknown as NonNullable<InterpretedOutput['request']> }),
    };
  }
  return { outcome: 'completed', result: output, summary: '', artifacts: [] };
}
