import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";

import { orderPlan } from "./plan.ts";

const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
};

describe("a plan of tasks", () => {
  test("is created each task after the tasks it waits for, whatever order it was written in", () => {
    const steps = orderPlan([
      { needs: [{ key: "review" }, { key: "fix" }] },
      { key: "review", needs: [{ key: "fix" }, "msg_existing"] },
      { key: "fix" },
    ]);
    expect(steps.map((step) => step.index)).toEqual([2, 1, 0]);
    expect(steps[1]).toEqual({ index: 1, needsExisting: ["msg_existing"], needsPlanned: [2] });
    expect(steps[2]?.needsPlanned).toEqual([1, 2]);
  });

  test("refuses keys that repeat, name nothing, or lead in a circle", () => {
    expect(code(() => orderPlan([{ key: "a" }, { key: "a" }]))).toBe("invalid_task");
    expect(code(() => orderPlan([{ needs: [{ key: "nope" }] }]))).toBe("invalid_needs");
    expect(code(() => orderPlan([{ key: "a", needs: [{ key: "a" }] }]))).toBe("invalid_needs");
    const circle = [
      { key: "a", needs: [{ key: "b" }] },
      { key: "b", needs: [{ key: "a" }] },
    ];
    expect(code(() => orderPlan(circle))).toBe("invalid_needs");
  });

  test("holds up to fifteen tasks", () => {
    expect(code(() => orderPlan([]))).toBe("invalid_task");
    expect(code(() => orderPlan(Array.from({ length: 15 }, () => ({}))))).toBeNull();
    expect(code(() => orderPlan(Array.from({ length: 16 }, () => ({}))))).toBe("invalid_task");
  });
});
