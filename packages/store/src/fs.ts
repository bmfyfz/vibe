import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BlobStore } from "@vibe/kernel";

/**
 * A blob store in a directory: what `vibe serve` keeps attachments in. Each
 * blob is a file named by its key, with its content type in a file beside it.
 */
export function fsBlobStore(dir: string): BlobStore {
  // A key is `vibe/attachment`, made of IDs. Anything else is refused, so no
  // key can name a file outside the directory.
  const pathOf = (key: string) => {
    if (!/^[\w-]+(\/[\w-]+)*$/.test(key)) throw new Error(`"${key}" is not a blob key.`);
    return join(dir, key);
  };

  return {
    async put(key, body, meta) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      // Written beside its place and moved in, so a reader never sees half a file.
      const partial = `${path}.partial`;
      try {
        await Bun.write(partial, new Response(body));
        await Bun.write(`${path}.type`, meta.contentType);
        await rename(partial, path);
      } catch (error) {
        await rm(partial, { force: true });
        throw error;
      }
      return { size: (await stat(path)).size };
    },
    async get(key) {
      const file = Bun.file(pathOf(key));
      if (!(await file.exists())) return null;
      const type = Bun.file(`${pathOf(key)}.type`);
      return {
        body: file.stream(),
        size: file.size,
        contentType: (await type.exists()) ? await type.text() : "application/octet-stream",
      };
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
      await rm(`${pathOf(key)}.type`, { force: true });
    },
  };
}
