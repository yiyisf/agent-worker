/**
 * 能力—配置一致性校验，见 docs/architecture.md §4.4。
 *
 * 这是本设计里最容易被省略、也最不该省略的部分：宣称「支持任意 SDK」而不说清能力差异，
 * 会让用户在 harness 上误以为拿到了 effectively-once 与调用级成本管控。
 *
 * 所有拒绝都发生在**启动时**，不留到运行期。
 */
import type { AgentSpec } from './spec.js';
import type { EngineCapabilities } from './engine.js';
import { CapabilityError } from './errors.js';

export interface CapabilityCheck {
  /** 允许启动，但有能力降级，必须让用户看见 */
  warnings: string[];
}

export interface CapabilityContext {
  /**
   * 引擎自带的内建工具名（如 harness 的读写文件、跑命令）。
   * core 无从分辨哪些工具是内建的，必须由引擎适配器告知，
   * 否则 toolInterception='host-declared-only' 这条规则无从校验。
   */
  builtinTools?: readonly string[];
}

export function assertCapabilities(
  spec: AgentSpec,
  caps: EngineCapabilities,
  ctx: CapabilityContext = {},
): CapabilityCheck {
  const warnings: string[] = [];
  const policies = spec.toolPolicies ?? {};
  const builtins = new Set(ctx.builtinTools ?? []);
  const effectfulTools = Object.entries(policies)
    .filter(([, p]) => p.effect === 'effectful')
    .map(([name]) => name);
  const approvalTools = Object.entries(policies)
    .filter(([, p]) => p.approval === 'always' || p.approval === 'policy')
    .map(([name]) => name);

  // ── 成本可见性 ──
  if (caps.costVisibility === 'none') {
    throw new CapabilityError(
      `引擎 costVisibility='none'：完全看不见成本，journal 与预算都形同虚设，拒绝启动。`,
    );
  }
  if (caps.costVisibility === 'per-turn') {
    warnings.push(
      `引擎 costVisibility='per-turn'：拦不到单次模型调用，预算降级为轮间闸门 ` +
        `（跑完一轮结账，超了不发起下一轮）。单轮内的超支不可控，` +
        `成本敏感场景请把 limits.maxCostUsd 设得更保守。`,
    );
  }

  // ── 工具拦截 ──
  if (effectfulTools.length > 0) {
    if (caps.toolInterception === 'none') {
      throw new CapabilityError(
        `引擎 toolInterception='none' 但 spec 声明了 effectful 工具 [${effectfulTools.join(', ')}]：` +
          `幂等保护实际不存在，拒绝启动。`,
      );
    }
    if (caps.toolInterception === 'host-declared-only') {
      const onBuiltin = effectfulTools.filter((t) => builtins.has(t));
      if (onBuiltin.length > 0) {
        throw new CapabilityError(
          `effectful 声明在引擎的内建工具 [${onBuiltin.join(', ')}] 上，但这些工具由引擎自己执行、` +
            `我们碰不到，无法提供幂等保护，拒绝启动。` +
            `内建工具的副作用防护只能依赖引擎自身的 approval 机制与沙箱隔离。`,
        );
      }
      warnings.push(
        `引擎 toolInterception='host-declared-only'：只有我们声明的工具受保护，` +
          `引擎内建工具的副作用不在管控范围内。`,
      );
    }
  }

  // ── 挂起 / HITL ──
  if (approvalTools.length > 0 && caps.suspend === 'none') {
    throw new CapabilityError(
      `引擎 suspend='none' 但 spec 为 [${approvalTools.join(', ')}] 声明了 approval：` +
        `该引擎不支持人工审批，拒绝启动（不能让它跑到一半才发现停不下来）。`,
    );
  }

  // ── 恢复与分片 ──
  if (caps.state === 'engine-session') {
    warnings.push(
      `引擎 state='engine-session'：避免重复付费由引擎自己的 session resume 负责，` +
        `我们的 journal 只负责持久化它。`,
    );
  }
  if (caps.sliceControl === 'none') {
    warnings.push(
      `引擎 sliceControl='none'：一轮 = 一分片，分片时长由引擎决定。` +
        `请确保 limits.wallClockMs 按最坏情况的单轮时长设置（§15.3 第 1 条）。`,
    );
  }
  if (caps.progress === 'none') {
    warnings.push(`引擎 progress='none'：进展只能在分片边界上报。`);
  }

  // ── 租约与恢复策略的自洽 ──
  const lease = spec.conductor?.leaseStrategy ?? 'callback';
  const resume = spec.conductor?.resumePolicy ?? 'on-lease-loss';
  if (lease !== 'lease-extend' && resume === 'never') {
    throw new CapabilityError(
      `leaseStrategy='${lease}' 需要跨分片持久化状态，与 resumePolicy='never'（不落 journal）矛盾，拒绝启动。`,
    );
  }

  return { warnings };
}
