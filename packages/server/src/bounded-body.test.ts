import { describe, expect, test } from "bun:test";

import { textUpTo } from "./bounded-body.ts";

const tooMuch = () => new Error("too much");

/** A body of `chunks` chunks of `size` bytes with no declared length, and a count of how many were asked for. */
function streamed(chunks: number, size: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === chunks) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(97));
    },
  });
  const request = new Request("http://vibe.test/", { method: "POST", body });
  return { request, pulled: () => pulled };
}

describe("reading a body up to a limit", () => {
  test("a body within the limit is read whole, as text", async () => {
    const request = new Request("http://vibe.test/", { method: "POST", body: "héllo ✓" });
    expect(await textUpTo(request, 100, tooMuch)).toBe("héllo ✓");
    const { request: chunked } = streamed(3, 4);
    expect(await textUpTo(chunked, 12, tooMuch)).toBe("aaaaaaaaaaaa");
    expect(await textUpTo(new Request("http://vibe.test/"), 10, tooMuch)).toBe("");
  });

  test("a declared length over the limit is refused before anything is read", async () => {
    const { request, pulled } = streamed(100, 10);
    request.headers.set("content-length", "1000");
    await expect(textUpTo(request, 999, tooMuch)).rejects.toThrow("too much");
    // One piece is what a stream makes ready before anyone reads it.
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  test("a body with no declared length is given up on once it passes the limit", async () => {
    const { request, pulled } = streamed(10_000, 1024);
    expect(request.headers.get("content-length")).toBeNull();
    await expect(textUpTo(request, 8 * 1024, tooMuch)).rejects.toThrow("too much");
    // The limit, and what a stream hands over ahead of its reader. Not ten megabytes.
    expect(pulled()).toBeLessThan(16);
  });

  test("the limit counts bytes, not characters", async () => {
    const text = "✓".repeat(10);
    const exact = new Request("http://vibe.test/", { method: "POST", body: text });
    expect(await textUpTo(exact, 30, tooMuch)).toBe(text);
    const { request } = streamed(1, 31);
    await expect(textUpTo(request, 30, tooMuch)).rejects.toThrow("too much");
  });
});
