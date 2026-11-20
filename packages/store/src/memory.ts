import type { BlobStore } from "@vibe/kernel";

/** A blob store that forgets everything when the process exits. For tests. */
export function memoryBlobStore(): BlobStore {
  const blobs = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>();

  return {
    async put(key, body, meta) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      blobs.set(key, { bytes, contentType: meta.contentType });
      return { size: bytes.byteLength };
    },

    async get(key) {
      const blob = blobs.get(key);
      if (!blob) return null;
      const body = new Blob([blob.bytes]).stream();
      return { body, size: blob.bytes.byteLength, contentType: blob.contentType };
    },

    async delete(key) {
      blobs.delete(key);
    },
  };
}
