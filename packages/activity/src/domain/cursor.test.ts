import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";

import { decodeCursor, encodeCursor, isMessageId } from "./cursor.ts";

describe("cursors", () => {
  test("round-trip", () => {
    for (const seq of [0, 1, 35, 36, 123_456_789, Number.MAX_SAFE_INTEGER]) {
      expect(decodeCursor(encodeCursor(seq))).toBe(seq);
    }
  });

  test("reject anything Vibe didn't hand out", () => {
    for (const bad of ["", "12", "cur_", "cur_-1", "cur_ABC", "msg_01", "cur_zzzzzzzzzzzz"]) {
      expect(() => decodeCursor(bad)).toThrow(DomainError);
    }
  });

  test("message IDs are recognised", () => {
    expect(isMessageId("msg_01jd")).toBe(true);
    expect(isMessageId("cur_1")).toBe(false);
  });
});
