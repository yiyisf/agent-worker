/**
 * @ca/memory —— BlobStore / MemoryStore 的持久化实现。见 docs/architecture.md §8。
 *
 * ⚠️ v0.8 之后本包**不再承担运行状态**：extendLease 心跳保证一次执行始终在同一个
 * worker 进程内（ADR-0022），agent 的状态全程在内存里，SDK 默认**零外部依赖**。
 * 只有「结果超过 outputData 预算需要外置」时才用得上这里。
 *
 * 待实现（M2+）：s3 BlobStore、MemoryStore（跨 run 长期记忆）
 */
export * from './redis.js';
