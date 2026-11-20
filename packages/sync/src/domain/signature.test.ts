import { describe, expect, test } from "bun:test";

import { hmacHex, verifyHmacHex } from "./signature.ts";

describe("webhook signatures", () => {
  // The example GitHub's documentation of validating deliveries works through.
  const secret = "It's a Secret to Everybody";
  const body = "Hello, World!";
  const signature = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  test("are HMAC-SHA256 of the body as it arrived, in hex", async () => {
    expect(await hmacHex(secret, body)).toBe(signature);
    expect(await verifyHmacHex(secret, body, signature)).toBe(true);
    expect(await verifyHmacHex(secret, body, signature.toUpperCase())).toBe(true);
  });

  test("don't hold for another body, another secret, or something that isn't a signature", async () => {
    expect(await verifyHmacHex(secret, "Hello, World?", signature)).toBe(false);
    expect(await verifyHmacHex("another secret", body, signature)).toBe(false);
    expect(await verifyHmacHex(secret, body, signature.slice(0, -2))).toBe(false);
    expect(await verifyHmacHex(secret, body, "")).toBe(false);
    expect(await verifyHmacHex(secret, body, `${signature.slice(0, -1)}g`)).toBe(false);
  });
});
