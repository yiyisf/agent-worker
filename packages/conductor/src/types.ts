/**
 * 与官方 SDK 的类型边界，见 docs/architecture.md §4.2 与 ADR-0006。
 *
 * 传输层类型（Task / TaskResult / ConductorWorker / TaskManager）一律来自
 * `@io-orkes/conductor-javascript`，本项目不再自定义。这里只放桥接层自己的类型。
 *
 * 占位：仅声明契约。
 */
import type { LeaseStrategy, ResumePolicy } from '@ca/core';

/** 官方 SDK 的连接配置约定（env 优先，与其他 Conductor 客户端一致），见 connection.ts */
export interface ConnectionOptions {
  /** 默认取 CONDUCTOR_SERVER_URL，缺省 http://localhost:8080/api */
  serverUrl?: string;
  /** 默认取 CONDUCTOR_AUTH_KEY / CONDUCTOR_AUTH_SECRET（Orkes 风格 key；OSS 通常不需要） */
  authKey?: string;
  authSecret?: string;
  /** 网关鉴权：每次请求前调用，调用方负责缓存与提前刷新（poll 是高频调用） */
  tokenProvider?: () => Promise<string>;
  /** 附加到每个请求的固定 header */
  headers?: Record<string, string>;
  /** 非长轮询请求的超时，默认 15s */
  requestTimeoutMs?: number;
}

/** 编译 ConductorWorker 时需要的每-Agent 参数 */
export interface AgentWorkerBinding {
  taskDefName: string;
  domain?: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseStrategy: LeaseStrategy;
  resumePolicy: ResumePolicy;
  /** callback / hybrid 策略下单次交还的等待秒数上限，受 timeoutSeconds 约束 */
  maxCallbackAfterSeconds?: number;
}
