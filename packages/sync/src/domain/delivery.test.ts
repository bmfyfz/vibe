import { describe, expect, test } from "bun:test";

import { conflict, forbidden, notFound } from "@vibe/kernel";

import { isFinalRefusal } from "./delivery.ts";

describe("what a platform sent, and the vibe refused", () => {
  test("a refusal that would be the same next time settles the event", () => {
    expect(isFinalRefusal(forbidden("forbidden", "Not here."))).toBe(true);
    expect(isFinalRefusal(notFound("message_not_found", "No such message."))).toBe(true);
    expect(isFinalRefusal(conflict("newer_message", "Someone wrote since."))).toBe(true);
  });

  test("a thread too busy to write to does not: the platform's next try must find it to do", () => {
    expect(isFinalRefusal(conflict("write_conflict", "The thread is busy."))).toBe(false);
  });

  test("a failure that is no refusal at all does not either", () => {
    expect(isFinalRefusal(new Error("the database is away"))).toBe(false);
    expect(isFinalRefusal("nothing")).toBe(false);
  });
});
