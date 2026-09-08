/**
 * 大 payload 的外置存储，见 docs/architecture.md §6.3。
 *
 * Conductor 的 outputData 有服务端阈值（默认 3072 KB 外置、10240 KB 直接失败），
 * 超预算的结果放这里，outputData 只留 ref。
 */
export interface BlobStore {
  put(
    key: string,
    body: Uint8Array | string,
    contentType?: string,
  ): Promise<{ ref: string; bytes: number; sha256: string }>;
  get(ref: string): Promise<Uint8Array>;
}
