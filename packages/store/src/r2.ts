import type { BlobStore } from "@vibe/kernel";

// The slice of R2's API this adapter uses. A real `R2Bucket` satisfies it.
export interface R2Like {
  put(
    key: string,
    value: ReadableStream,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<{ size: number } | null>;
  get(key: string): Promise<{
    body: ReadableStream;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(key: string): Promise<void>;
}

export function r2BlobStore(bucket: R2Like): BlobStore {
  return {
    async put(key, body, meta) {
      const object = await bucket.put(key, body, {
        httpMetadata: { contentType: meta.contentType },
      });
      if (!object) throw new Error(`R2 refused to store ${key}.`);
      return { size: object.size };
    },

    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        body: object.body as ReadableStream<Uint8Array>,
        size: object.size,
        contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      };
    },

    delete: (key) => bucket.delete(key),
  };
}
