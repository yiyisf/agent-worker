/**
 * 准入控制，见 docs/architecture.md §6.5（对应约束 C7）。占位：仅声明契约。
 *
 * 官方 TaskManager 的 concurrency 是静态值；本模块在其上动态调节，
 * 让「LLM 配额」而不是「线程数」成为真正的并发闸门。令牌预算耗尽时把 concurrency 调到 0，
 * 官方 poll 循环自然停拉，避免拉了任务却卡在限流上占着租约。
 */
export interface AdmissionSignal {
  /** 当前可安全承接的运行数上限 */
  availableSlots(): number;
}

export interface AdmissionController {
  register(signal: AdmissionSignal): void;
  /** 由桥接层周期性调用，把目标并发写回官方 TaskManager */
  targetConcurrency(): number;
}
