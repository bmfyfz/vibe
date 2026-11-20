import { invalidMessage } from "./errors.ts";

/**
 * Structured data on a message: an object that matched the schema it names
 * when the message was written, so a program reads it and never parses text.
 */
export interface Block {
  /** The schema's name, such as `sandbox`. */
  readonly schema: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A block as its writer gives it: the schema by its ID, such as `sandbox@1`, and the data. */
export interface BlockInput {
  readonly schema: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export const MAX_BLOCKS = 8;
/** How much data one message carries, as JSON, across its blocks. */
export const MAX_BLOCKS_BYTES = 64 * 1024;

/** What a message's blocks must satisfy together. Each block's own schema is checked apart from this. */
export function assertBlocks(blocks: readonly Block[]): void {
  if (blocks.length > MAX_BLOCKS) {
    throw invalidMessage(`A message carries up to ${MAX_BLOCKS} blocks of data.`);
  }
  const size = new TextEncoder().encode(JSON.stringify(blocks.map((block) => block.data)));
  if (size.byteLength > MAX_BLOCKS_BYTES) {
    throw invalidMessage(
      `A message carries up to ${MAX_BLOCKS_BYTES / 1024} kB of data.`,
      "Put larger data in a file and attach it.",
    );
  }
}

/** Whether two lists of blocks hold the same data under the same schemas, in the same order. */
export function sameBlocks(a: readonly Block[], b: readonly Block[]): boolean {
  return canonical(a) === canonical(b);
}

/** JSON with every object's keys in order, so two values that are equal print the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner).sort())
      sorted[key] = (inner as Record<string, unknown>)[key];
    return sorted;
  });
}
