import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";

import { plan, Schedule, type Timing } from "./schedule.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_000_000_000;
const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
};
const ada = { actorId: "vibe:user:u_ada", principal: "vibe:user:u_ada", profile: null };
const schedule = (timing: Timing) =>
  Schedule.create({
    id: "sch_1",
    vibeId: "vb_1",
    target: { channel: "dev", threadId: null, replyTo: null },
    content: { text: "standup", labels: {}, blocks: [], noSync: false },
    author: ada,
    timing,
    now: NOW,
  });

describe("a schedule's timing", () => {
  test("posts once after a delay or at a time", () => {
    expect(plan({ in: HOUR }, NOW)).toEqual({
      firstAt: NOW + HOUR,
      every: null,
      until: null,
      times: null,
    });
    expect(plan({ at: NOW + 5 * HOUR }, NOW).firstAt).toBe(NOW + 5 * HOUR);
    // A time a moment ago is now, not an error: clocks differ.
    expect(plan({ at: NOW - 5000 }, NOW).firstAt).toBe(NOW);
  });

  test("repeats from one interval on, or from the time given", () => {
    expect(plan({ every: HOUR }, NOW)).toMatchObject({ firstAt: NOW + HOUR, every: HOUR });
    expect(plan({ every: HOUR, at: NOW + 10 }, NOW).firstAt).toBe(NOW + 10);
    expect(plan({ every: HOUR, in: MINUTE }, NOW).firstAt).toBe(NOW + MINUTE);
  });

  test("ends after a span counted from its first post, at a time, or after a number", () => {
    expect(plan({ every: HOUR, at: NOW + HOUR, for: 8 * HOUR }, NOW).until).toBe(NOW + 9 * HOUR);
    expect(plan({ every: HOUR, until: NOW + 3 * HOUR }, NOW).until).toBe(NOW + 3 * HOUR);
    expect(plan({ every: HOUR, times: 3 }, NOW).times).toBe(3);
  });

  test("is refused when it says nothing, contradicts itself, or asks too much", () => {
    const refused: Timing[] = [
      {},
      { in: HOUR, at: NOW + HOUR },
      { every: MINUTE - 1 },
      { in: 500 },
      { in: -HOUR },
      { in: Number.NaN },
      { at: Number.NaN },
      { at: NOW - HOUR },
      { in: HOUR, times: 3 },
      { in: HOUR, for: HOUR },
      { at: NOW + HOUR, until: NOW + 2 * HOUR },
      { every: HOUR, for: HOUR, until: NOW + HOUR },
      { every: HOUR, times: 0 },
      { every: HOUR, times: 1.5 },
      { every: HOUR, times: 10_001 },
      { every: HOUR, until: NOW + MINUTE },
      { in: 400 * 24 * HOUR },
      { in: 1e300 },
      { every: 400 * 24 * HOUR },
      { every: 1e15, in: MINUTE },
      { every: MINUTE, for: 1e16 },
      { every: MINUTE, for: 4000 * 24 * HOUR },
      { every: MINUTE, until: 8.64e15 },
      { every: MINUTE, until: 1e300 },
    ];
    for (const timing of refused) {
      expect([timing, code(() => plan(timing, NOW))]).toEqual([timing, "invalid_schedule"]);
    }
  });
});

describe("Schedule", () => {
  test("a single post is done once it fires", () => {
    const once = schedule({ in: HOUR });
    expect(once.isDue(NOW + HOUR - 1)).toBe(false);
    expect(once.isDue(NOW + HOUR)).toBe(true);

    once.fired({ messageId: "msg_1", now: NOW + HOUR + 5 });
    expect(once.snapshot).toMatchObject({
      state: "done",
      runs: 1,
      lastMessageId: "msg_1",
      lastRunAt: NOW + HOUR + 5,
    });
    expect(once.isDue(NOW + 2 * HOUR)).toBe(false);
  });

  test("a repeating one keeps to its times, however late each firing ran", () => {
    const hourly = schedule({ every: HOUR });
    hourly.fired({ messageId: "msg_1", now: NOW + HOUR + 40_000 });
    expect(hourly.snapshot).toMatchObject({ state: "pending", nextAt: NOW + 2 * HOUR, runs: 1 });
    hourly.fired({ messageId: "msg_2", now: NOW + 2 * HOUR });
    expect(hourly.snapshot.nextAt).toBe(NOW + 3 * HOUR);
  });

  test("firings missed while the scheduler was down are skipped, not made up for", () => {
    const hourly = schedule({ every: HOUR });
    hourly.fired({ messageId: "msg_1", now: NOW + 4 * HOUR + 2 * MINUTE });
    expect(hourly.snapshot).toMatchObject({ state: "pending", nextAt: NOW + 5 * HOUR, runs: 1 });
  });

  test("a time that has only just gone by is late, not missed", () => {
    // Each minute, and each firing lands a moment after the following time:
    // the scheduler's tick falls just before the schedule's own second.
    const minutely = schedule({ every: MINUTE });
    for (const n of [1, 2, 3, 4]) {
      expect(minutely.snapshot.nextAt).toBe(NOW + n * MINUTE);
      expect(minutely.isDue(NOW + n * MINUTE + 59_950)).toBe(true);
      minutely.fired({ messageId: `msg_${n}`, now: NOW + (n + 1) * MINUTE + 70 });
    }
    expect(minutely.snapshot).toMatchObject({ runs: 4, nextAt: NOW + 5 * MINUTE });

    // Two ticks behind is a miss: one time is dropped, and it is level again.
    minutely.fired({ messageId: "msg_5", now: NOW + 7 * MINUTE + 70 });
    expect(minutely.snapshot.nextAt).toBe(NOW + 7 * MINUTE);
  });

  test("ends after its number of firings, or when the next would pass its end", () => {
    const thrice = schedule({ every: HOUR, times: 3 });
    for (const n of [1, 2, 3]) thrice.fired({ messageId: `msg_${n}`, now: NOW + n * HOUR });
    expect(thrice.snapshot).toMatchObject({ state: "done", runs: 3, remaining: 0 });

    const morning = schedule({ every: HOUR, for: 2 * HOUR });
    morning.fired({ messageId: "msg_1", now: NOW + HOUR });
    morning.fired({ messageId: "msg_2", now: NOW + 2 * HOUR });
    expect(morning.snapshot.state).toBe("pending");
    morning.fired({ messageId: "msg_3", now: NOW + 3 * HOUR });
    expect(morning.snapshot).toMatchObject({ state: "done", runs: 3 });
  });

  test("each firing posts under a key of its own", () => {
    const hourly = schedule({ every: HOUR });
    expect(hourly.firingKey).toBe("sch_1:1");
    hourly.fired({ messageId: "msg_1", now: NOW + HOUR });
    expect(hourly.firingKey).toBe("sch_1:2");
  });

  test("is canceled or stopped once, while it is pending", () => {
    const hourly = schedule({ every: HOUR });
    expect(hourly.cancel({ now: NOW + 1 })).toBe(true);
    expect(hourly.cancel({ now: NOW + 2 })).toBe(false);
    hourly.stop({ reason: "forbidden", now: NOW + 3 });
    expect(hourly.snapshot).toMatchObject({ state: "canceled", reason: null, updatedAt: NOW + 1 });
    expect(hourly.isDue(NOW + 2 * HOUR)).toBe(false);

    const refused = schedule({ in: HOUR });
    refused.stop({ reason: "forbidden", now: NOW + HOUR });
    expect(refused.snapshot).toMatchObject({ state: "stopped", reason: "forbidden" });
  });

  test("belongs to its author, and to the person behind a profile that made it", () => {
    const fx = { actorId: "vibe:user:u_ada+fx", principal: "vibe:user:u_ada", profile: "fx" };
    const byProfile = Schedule.create({
      id: "sch_2",
      vibeId: "vb_1",
      target: { channel: "dev", threadId: null, replyTo: null },
      content: { text: "ping", labels: {}, blocks: [], noSync: false },
      author: fx,
      timing: { in: HOUR },
      now: NOW,
    });
    expect(byProfile.scheduledBy(fx)).toBe(true);
    expect(byProfile.scheduledBy(ada)).toBe(true);
    expect(
      byProfile.scheduledBy({ ...fx, actorId: "vibe:user:u_ada+codex", profile: "codex" }),
    ).toBe(false);
    expect(schedule({ in: HOUR }).scheduledBy(fx)).toBe(false);
    const bob = { actorId: "vibe:user:u_bob", principal: "vibe:user:u_bob", profile: null };
    expect(byProfile.scheduledBy(bob)).toBe(false);
  });
});
