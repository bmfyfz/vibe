export interface StoredBlob {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly contentType: string;
}

/** Where attachment bytes live. R2 in production; memory in tests. */
export interface BlobStore {
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    meta: { contentType: string },
  ): Promise<{ size: number }>;
  get(key: string): Promise<StoredBlob | null>;
  delete(key: string): Promise<void>;
}
