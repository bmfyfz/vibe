import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";
import { createDb, schema } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";

import type { Budget } from "../domain/attempts.ts";
import { DrizzleAttemptRepository } from "../infrastructure/drizzle-attempts.ts";
import { Attempts } from "./attempts.ts";

const budget: Budget = { name: "test", most: 3, windowMs: 60_000, refusal: "Too many." };
const START = 1_795_000_020_000; // The start of a stretch, to the millisecond.

function setup() {
  const db = createDb(bunSqliteExecutor(openDatabase()));
  let now = START;
  const attempts = new Attempts(new DrizzleAttemptRepository(db), { now: () => now });
  return {
    attempts,
    db,
    pass(ms: number) {
      now += ms;
    },
  };
}

const refusal = (error: unknown) =>
  error instanceof DomainError ? [error.code, error.retryAfterMs] : String(error);
const refused = (work: Promise<unknown>) => work.then(() => "let through", refusal);

describe("attempts that failed", () => {
  test("a caller is refused once as many as the budget allows have failed", async () => {
    const { attempts, pass } = setup();
    for (let n = 0; n < 3; n++) {
      expect(await refused(attempts.require(budget, "a"))).toBe("let through");
      await attempts.failed(budget, "a");
    }
    pass(10_000);
    // The refusal says how long is left of the stretch.
    expect(await refused(attempts.require(budget, "a"))).toEqual(["rate_limited", 50_000]);
  });

  test("one caller using its budget up refuses no one else", async () => {
    const { attempts } = setup();
    for (let n = 0; n < 5; n++) await attempts.failed(budget, "a");
    expect(await refused(attempts.require(budget, "a"))).toEqual(["rate_limited", 60_000]);
    expect(await refused(attempts.require(budget, "b"))).toBe("let through");
    // Nor in another budget, under the same name.
    expect(await refused(attempts.require({ ...budget, name: "other" }, "a"))).toBe("let through");
  });

  test("a caller counted under several names is refused when any of them is used up", async () => {
    const { attempts } = setup();
    for (let n = 0; n < 3; n++) await attempts.failed(budget, "a:entry");
    expect(await refused(attempts.require(budget, "a:-", "a:entry"))).toEqual([
      "rate_limited",
      60_000,
    ]);
    expect(await refused(attempts.require(budget, "a:-", "a:other"))).toBe("let through");
  });

  test("the next stretch starts the count again", async () => {
    const { attempts, pass } = setup();
    for (let n = 0; n < 3; n++) await attempts.failed(budget, "a");
    pass(59_999);
    expect(await refused(attempts.require(budget, "a"))).toEqual(["rate_limited", 1]);
    pass(1);
    expect(await refused(attempts.require(budget, "a"))).toBe("let through");
    // Two more failures don't reach the budget: the old three are not carried over.
    await attempts.failed(budget, "a");
    await attempts.failed(budget, "a");
    expect(await refused(attempts.require(budget, "a"))).toBe("let through");
    await attempts.failed(budget, "a");
    expect(await refused(attempts.require(budget, "a"))).toEqual(["rate_limited", 60_000]);
  });

  test("with no one to count against, nothing is counted and no one is refused", async () => {
    const { attempts, db } = setup();
    for (let n = 0; n < 5; n++) await attempts.failed(budget, null);
    expect(await refused(attempts.require(budget, null))).toBe("let through");
    expect(await refused(attempts.take(budget, null))).toBe("let through");
    expect(await db.select().from(schema.attempts)).toEqual([]);
  });
});

describe("attempts counted before they are made", () => {
  test("of many made at once, only as many as the budget allows go ahead", async () => {
    const { attempts } = setup();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => refused(attempts.take(budget, "a"))),
    );
    expect(results.filter((result) => result === "let through")).toHaveLength(3);
    expect(results.filter((result) => result !== "let through")).toHaveLength(7);
    // The ones refused were not counted on top.
    expect(await refused(attempts.take(budget, "b"))).toBe("let through");
  });

  test("an attempt that was good is given back, and only bad ones use the budget up", async () => {
    const { attempts } = setup();
    for (let n = 0; n < 20; n++) await attempts.giveBack(await attempts.take(budget, "a"));
    await attempts.take(budget, "a");
    await attempts.take(budget, "a");
    await attempts.giveBack(await attempts.take(budget, "a"));
    await attempts.take(budget, "a");
    expect(await refused(attempts.take(budget, "a"))).toEqual(["rate_limited", 60_000]);
  });

  test("an attempt handed back after its stretch ended takes nothing off the next one", async () => {
    const { attempts, pass } = setup();
    const early = await attempts.take(budget, "a");
    pass(60_000);
    await attempts.take(budget, "a");
    await attempts.take(budget, "a");
    await attempts.giveBack(early);
    await attempts.take(budget, "a");
    expect(await refused(attempts.take(budget, "a"))).toEqual(["rate_limited", 60_000]);
  });

  test("a server whose clock runs behind counts into the stretch the others are in", async () => {
    const { attempts, pass } = setup();
    pass(60_000);
    await attempts.take(budget, "a");
    await attempts.take(budget, "a");
    // Another server, a moment behind, still thinks it is the stretch before.
    pass(-5);
    await attempts.take(budget, "a");
    pass(5);
    expect(await refused(attempts.take(budget, "a"))).toEqual(["rate_limited", 60_000]);
  });
});

describe("counts that are over", () => {
  test("are forgotten by a pass, and the ones still running are kept", async () => {
    const { attempts, db, pass } = setup();
    const long: Budget = { ...budget, name: "long", windowMs: 600_000 };
    await attempts.failed(budget, "a");
    await attempts.failed(long, "a");
    pass(60_000);
    await attempts.failed(budget, "b");
    await attempts.prune();
    const kept = (await db.select().from(schema.attempts)).map((row) => row.key).sort();
    expect(kept).toEqual(["long:a", "test:b"]);
  });
});
