/**
 * 护栏，见 docs/architecture.md §9。占位：仅声明契约。
 *
 * v0.4 变化：护栏挂在两个受管入口上（而非 core 自建循环的各阶段），
 * 因此换引擎不丢护栏 —— 与 OTel 埋点同理（ADR-0012）。
 */
import type { JsonValue } from './spec.js';

export type GuardrailStage = 'before-model' | 'after-model' | 'before-tool' | 'after-tool';

export type GuardrailVerdict =
  | { action: 'allow' }
  | { action: 'rewrite'; value: JsonValue }
  | { action: 'block'; rule: string; terminal: boolean };

export interface Guardrail {
  name: string;
  stages: GuardrailStage[];
  check(args: {
    stage: GuardrailStage;
    /** 模型请求/响应载荷，或工具名与入参/出参 */
    payload: JsonValue;
    toolName?: string;
    /** 该载荷是否来自不可信来源（ToolPolicy.trust） */
    trust?: 'trusted' | 'untrusted';
  }): Promise<GuardrailVerdict>;
}
