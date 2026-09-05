/**
 * @ca/memory —— StateStore / BlobStore 的持久化实现。见 docs/architecture.md §8。
 *
 * 默认的 callback 分片策略要求持久化 StateStore；@ca/core 里的内存实现只供本地开发，
 * createAgentWorker 会在启动时拒绝它。
 *
 * 待实现（M2+）：postgres StateStore、s3 BlobStore、MemoryStore（跨 run 长期记忆）
 */
export * from './redis.js';
