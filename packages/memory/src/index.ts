/**
 * @ca/memory —— StateStore / BlobStore / MemoryStore 的实现集合。
 * 见 docs/architecture.md §9。三者职责必须分清：
 *   StateStore  journal / 租约 / resume，生命周期 = 一次 run（+ 排障 TTL）
 *   BlobStore   transcript / 大 payload，生命周期 = 审计要求
 *   MemoryStore 跨 run 的长期记忆，生命周期 = 业务定义
 *
 * M0 骨架：待实现 memoryStateStore / redisStateStore / postgresStateStore / fsBlobStore / s3BlobStore
 */
export {};
