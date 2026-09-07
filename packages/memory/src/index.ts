/**
 * @ca/memory —— 运行注册表 / BlobStore 的持久化实现。见 docs/architecture.md §8。
 *
 * 多实例部署**必须**用这里的 RedisRunRegistry：@ca/core 的内存实现只在单进程内有效，
 * 而 Conductor 不保证 callback 回到同一个 worker。
 *
 * 待实现（M2+）：postgres 注册表、s3 BlobStore、MemoryStore（跨 run 长期记忆）
 */
export * from './redis.js';
