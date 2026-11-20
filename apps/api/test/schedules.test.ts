import { describe, expect, test } from "bun:test";

import { block, type Schedule, VibeError, type VibeHandle } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
const status = (error: unknown) => (error instanceof VibeError ? error.status : -1);
const MINUTE = 60_000;

/** Without a way to run the scheduler there is nothing to check a firing with. */
const fires = test.skipIf(vibe.fireSchedules === null);
/** What takes longer than a test can wait runs only where the clock can jump. */
const jumps = test.skipIf(!vibe.canJump || vibe.fireSchedules === null);

/** Runs the scheduler until a schedule is as expected, since a running Vibe answers in its own time. */
async function fire(as: VibeHandle, id: string, until: (schedule: Schedule) => boolean) {
  for (let attempt = 1; ; attempt++) {
    await vibe.fireSchedules?.();
    const schedule = await as.getSchedule(id);
    if (until(schedule) || attempt === 20) return schedule;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const texts = async (as: VibeHandle, channel: string) =>
  (await as.threads({ channel })).threads.map((thread) => thread.message.text);

describe("schedules", () => {
  fires("a schedule posts once, later, as whoever made it", async () => {
    const { handle, client: ada } = await vibe.join();
    const channel = vibe.channel();

    const made = await ada.as("fx").schedule(channel, { text: "is it done?", in: "1s" });
    expect(made).toMatchObject({
      channel,
      re: null,
      text: "is it done?",
      state: "pending",
      every: null,
      runs: 0,
      by: { handle: `${handle}/fx` },
    });
    expect(made.id).toStartWith("sch_");
    expect(Date.parse(made.nextAt ?? "") - Date.parse(made.createdAt)).toBe(1000);

    // Not before its time.
    await vibe.fireSchedules?.();
    expect(await texts(ada, channel)).toEqual([]);

    await vibe.pass(1100);
    const done = await fire(ada, made.id, (schedule) => schedule.state === "done");
    expect(done).toMatchObject({ state: "done", runs: 1, nextAt: null });
    const { threads } = await ada.threads({ channel });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.message).toMatchObject({
      id: done.lastMessageId,
      text: "is it done?",
      by: { handle: `${handle}/fx`, profile: "fx" },
    });

    // The scheduler running again posts nothing more.
    await vibe.fireSchedules?.();
    await vibe.fireSchedules?.();
    expect(await texts(ada, channel)).toEqual(["is it done?"]);
  });

  fires("a schedule replies in a thread, which lists it while it is pending", async () => {
    const { client: ada } = await vibe.join();
    const { handle: bobHandle, client: bob } = await vibe.join();
    const root = await ada.post(vibe.channel(), "checkout times out");
    const reply = await bob.reply(root.id, "looking");

    const made = await ada.schedule(
      { re: reply.id },
      { text: `@${bobHandle} still broken?`, in: 1000 },
    );
    expect(made).toMatchObject({ channel: root.channel, re: root.id, state: "pending" });
    expect((await bob.thread(root.id)).schedules.map((schedule) => schedule.id)).toEqual([made.id]);
    expect((await bob.schedules({ re: reply.id })).map((schedule) => schedule.id)).toEqual([
      made.id,
    ]);

    await vibe.pass(1100);
    const done = await fire(ada, made.id, (schedule) => schedule.state === "done");
    const thread = await bob.thread(root.id);
    expect(thread.schedules).toEqual([]);
    expect(thread.replies.map((message) => message.id)).toEqual([
      reply.id,
      done.lastMessageId ?? "",
    ]);
    // It answers the message it named, and its mention is settled when it posts.
    expect(thread.replies[1]).toMatchObject({ replyTo: reply.id, re: root.id });
    expect(thread.replies[1]?.mentions.map((mention) => mention.handle)).toEqual([bobHandle]);
  });

  fires("a scheduled post carries its labels and its data", async () => {
    const { client: ada } = await vibe.join();
    const sandbox = vibe.channel("sandbox");
    await ada.createSchema({
      name: sandbox,
      version: 1,
      schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    });
    const channel = vibe.channel();

    const bad = await ada
      .schedule(channel, { blocks: [block(`${sandbox}@1`, { id: 7 })], in: "1s" })
      .catch((e) => e);
    expect([code(bad), status(bad)]).toEqual(["invalid_block", 400]);

    const made = await ada.schedule(channel, {
      labels: { kind: "report" },
      blocks: [block(`${sandbox}@1`, { id: "sbx-1" })],
      in: "1s",
    });
    expect(made.blocks).toEqual([{ schema: `${sandbox}@1`, data: { id: "sbx-1" } }]);

    await vibe.pass(1100);
    await fire(ada, made.id, (schedule) => schedule.state === "done");
    const { threads } = await ada.threads({ channel });
    expect(threads[0]?.message).toMatchObject({
      text: "",
      labels: { kind: "report" },
      blocks: [{ schema: sandbox, version: 1, data: { id: "sbx-1" } }],
    });
  });

  jumps(
    "a repeating schedule posts at its interval, for as many times as it was given",
    async () => {
      const { client: ada } = await vibe.join();
      const channel = vibe.channel();
      const made = await ada.schedule(channel, { text: "standup", every: "1m", times: 3 });
      expect(made).toMatchObject({ every: 60, remaining: 3, state: "pending" });

      for (const [runs, state] of [
        [1, "pending"],
        [2, "pending"],
        [3, "done"],
      ] as const) {
        await vibe.pass(MINUTE);
        expect(await vibe.fireSchedules?.()).toMatchObject({ fired: 1, failed: 0 });
        // Once per interval, however often the scheduler looks.
        expect(await vibe.fireSchedules?.()).toMatchObject({ fired: 0 });
        expect(await ada.getSchedule(made.id)).toMatchObject({ runs, state, remaining: 3 - runs });
      }
      await vibe.pass(10 * MINUTE);
      await vibe.fireSchedules?.();
      expect(await texts(ada, channel)).toEqual(["standup", "standup", "standup"]);
    },
  );

  jumps("a repeating schedule ends at its time, and skips what the scheduler missed", async () => {
    const { client: ada } = await vibe.join();
    const channel = vibe.channel();
    const made = await ada.schedule(channel, { text: "ping", every: "10m", for: "50m" });
    const first = Date.parse(made.nextAt ?? "");
    expect(Date.parse(made.until ?? "")).toBe(first + 50 * MINUTE);

    // The scheduler was away for three intervals: one post, not three.
    await vibe.pass(35 * MINUTE);
    expect(await vibe.fireSchedules?.()).toMatchObject({ fired: 1 });
    expect(await vibe.fireSchedules?.()).toMatchObject({ fired: 0 });
    const after = await ada.getSchedule(made.id);
    expect(after).toMatchObject({ runs: 1, state: "pending" });
    expect(Date.parse(after.nextAt ?? "")).toBe(first + 30 * MINUTE);

    await vibe.pass(60 * MINUTE);
    await vibe.fireSchedules?.();
    expect(await ada.getSchedule(made.id)).toMatchObject({ runs: 2, state: "done" });
    expect(await texts(ada, channel)).toEqual(["ping", "ping"]);
  });

  jumps(
    "a schedule that repeats each minute posts each minute, however the ticks fall",
    async () => {
      const { client: ada } = await vibe.join();
      const channel = vibe.channel();
      const made = await ada.schedule(channel, { text: "tick", every: "1m" });
      try {
        // The scheduler looks just before the schedule's own second each time,
        // so every firing is a minute late and the next time has just gone by.
        await vibe.pass(2 * MINUTE - 50);
        for (const runs of [1, 2, 3, 4]) {
          expect(await vibe.fireSchedules?.()).toMatchObject({ fired: 1 });
          expect((await ada.getSchedule(made.id)).runs).toBe(runs);
          await vibe.pass(MINUTE);
        }
      } finally {
        await ada.cancelSchedule(made.id);
      }
    },
  );

  fires("a schedule stops when its author can no longer post there", async () => {
    const owner = await vibe.owner();
    const { handle, client: bob } = await vibe.join();
    const channel = vibe.channel();
    const made = await bob.schedule(channel, { text: "nightly report", every: "1m", in: "1s" });

    // Read is all bob is left with in the channel.
    const narrowed = await owner.createGrant({
      principals: [{ kind: "user", handle }],
      can: { [channel]: ["read"] },
    });
    try {
      await vibe.pass(1100);
      const stopped = await fire(bob, made.id, (schedule) => schedule.state !== "pending");
      expect(stopped).toMatchObject({
        state: "stopped",
        reason: "forbidden",
        runs: 0,
        nextAt: null,
      });
      expect(await texts(owner, channel)).toEqual([]);
    } finally {
      await owner.revokeGrant(narrowed.id);
    }

    // Getting the access back doesn't start it again.
    await vibe.fireSchedules?.();
    expect((await bob.getSchedule(made.id)).state).toBe("stopped");
    expect(await texts(owner, channel)).toEqual([]);
    expect((await bob.schedules({ channel })).map((schedule) => schedule.id)).toEqual([]);
    expect((await bob.schedules({ channel, all: true })).map((schedule) => schedule.id)).toEqual([
      made.id,
    ]);
  });

  test("a schedule is refused when its timing or its post would be", async () => {
    const { client: ada } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const channel = vibe.channel();
    const root = await ada.post(channel, "hello");
    const soon = new Date(Date.now() + 3_600_000);

    const timings: Parameters<VibeHandle["schedule"]>[1][] = [
      { text: "x" },
      { text: "x", in: "1h", at: soon },
      { text: "x", every: "30s" },
      { text: "x", in: "1h", times: 2 },
      { text: "x", at: soon, until: soon },
      { text: "x", every: "1h", for: "1d", until: soon },
      { text: "x", every: "1h", times: 0 },
      { text: "x", at: "next tuesday" },
      { text: "x", at: new Date(Date.now() - 3_600_000) },
      { text: "x", every: "1h", until: new Date(Date.now() + 60_000) },
      { text: "x", in: "500d" },
      { text: "x", every: "500d" },
      { text: "x", every: "1m", for: 1e19 },
      { text: "x", every: "1m", until: new Date(8.64e15) },
      // A time says which zone it is in, or it means one thing here and another there.
      { text: "x", at: "2030-01-01T09:00:00" },
      { text: "x", every: "1h", until: "2030-01-01" },
    ];
    for (const timing of timings) {
      const error = await ada.schedule(channel, timing).catch((e) => e);
      expect([timing, code(error), status(error)]).toEqual([timing, "invalid_schedule", 400]);
    }

    // Decided as the post would be: nothing to post, nowhere to post it, no right to.
    expect(code(await ada.schedule(channel, { in: "1h" }).catch((e) => e))).toBe("invalid_message");
    expect(code(await ada.schedule("Not A Channel", { text: "x", in: "1h" }).catch((e) => e))).toBe(
      "invalid_channel",
    );
    expect(
      code(await ada.schedule({ re: "msg_nope" }, { text: "x", in: "1h" }).catch((e) => e)),
    ).toBe("message_not_found");
    const refused = await viewer.schedule({ re: root.id }, { text: "x", in: "1h" }).catch((e) => e);
    expect([code(refused), status(refused)]).toEqual(["forbidden", 403]);
    expect(await ada.schedules({ channel })).toEqual([]);
  });

  test("you cancel your own schedules, or anyone's with manage in the channel", async () => {
    const owner = await vibe.owner();
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const channel = vibe.channel();
    const mine = await ada.schedule(channel, { text: "mine", every: "1h" });
    const agents = await ada.as("fx").schedule(channel, { text: "by fx", every: "1h" });
    const other = await ada.schedule(channel, { text: "other", in: "1h" });

    // A viewer reads the schedule and can't call it off.
    expect((await viewer.getSchedule(mine.id)).text).toBe("mine");
    const refused = await viewer.cancelSchedule(mine.id).catch((e) => e);
    expect([code(refused), status(refused)]).toEqual(["forbidden", 403]);

    const canceled = await ada.cancelSchedule(mine.id);
    expect(canceled).toMatchObject({
      canceled: true,
      schedule: { state: "canceled", nextAt: null },
    });
    expect(await ada.cancelSchedule(mine.id)).toMatchObject({
      canceled: false,
      schedule: { state: "canceled" },
    });
    // A person calls off what their agent scheduled.
    expect((await ada.cancelSchedule(agents.id)).canceled).toBe(true);
    // A member holds manage until a grant takes it away.
    expect((await bob.cancelSchedule(other.id)).canceled).toBe(true);

    const missing = await ada.cancelSchedule("sch_nope").catch((e) => e);
    expect([code(missing), status(missing)]).toEqual(["schedule_not_found", 404]);

    // Canceled schedules never fire.
    if (vibe.fireSchedules && vibe.canJump) {
      await vibe.pass(2 * 3_600_000);
      await vibe.fireSchedules();
      expect(await texts(owner, channel)).toEqual([]);
    }
  });

  test("schedules are listed oldest first, to those who can read their channel", async () => {
    const { handle, client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel("sched");
    // A moment apart, so each is older than the next.
    const first = await ada.schedule(channel, { text: "first", in: "1h" });
    await vibe.pass(2);
    const second = await ada.as("fx").schedule(channel, { text: "second", every: "1h" });
    await vibe.pass(2);
    const third = await bob.schedule(channel, { text: "third", in: "2h" });
    const ids = (list: Schedule[]) => list.map((schedule) => schedule.id);

    try {
      expect(ids(await bob.schedules({ channel }))).toEqual([first.id, second.id, third.id]);
      expect(ids(await bob.schedules({ channel, by: handle }))).toEqual([first.id, second.id]);
      expect(ids(await bob.schedules({ channel, by: `${handle}/fx` }))).toEqual([second.id]);
      expect(ids(await bob.schedules({ channel, by: "me" }))).toEqual([third.id]);
      expect(ids(await bob.schedules({ channel, limit: 2 }))).toEqual([first.id, second.id]);

      await ada.cancelSchedule(first.id);
      expect(ids(await bob.schedules({ channel }))).toEqual([second.id, third.id]);
      expect(ids(await bob.schedules({ channel, all: true }))).toEqual([
        first.id,
        second.id,
        third.id,
      ]);
    } finally {
      await ada.cancelSchedule(second.id);
      await bob.cancelSchedule(third.id);
    }
  });

  test("a schedule in a channel you can't read isn't there, unless it is yours", async () => {
    const owner = await vibe.owner();
    const { client: bob } = await vibe.join();
    const { client: eve } = await vibe.join();
    const channel = vibe.channel("secret");
    const hidden = await bob.schedule(channel, { text: "quarterly numbers", in: "1h" });
    expect((await eve.schedules({ channel })).map((schedule) => schedule.id)).toEqual([hidden.id]);

    // The channel closes to everyone but the owner, bob included.
    const keep = await owner.createGrant({
      principals: [{ kind: "user", handle: (await owner.whoami()).actor.handle }],
      can: { [channel]: "all" },
    });
    const close = await owner.createGrant({
      principals: [{ kind: "everyone" }],
      can: { [channel]: "none" },
    });
    try {
      expect(await eve.schedules({ channel })).toEqual([]);
      for (const attempt of [
        () => eve.getSchedule(hidden.id),
        () => eve.cancelSchedule(hidden.id),
      ]) {
        const error = await attempt().catch((e) => e);
        expect([code(error), status(error)]).toEqual(["schedule_not_found", 404]);
      }
      // Whoever made it still sees it, and can still call it off.
      expect((await bob.schedules({ channel })).map((schedule) => schedule.id)).toEqual([
        hidden.id,
      ]);
      expect((await bob.cancelSchedule(hidden.id)).canceled).toBe(true);
    } finally {
      await owner.revokeGrant(close.id);
      await owner.revokeGrant(keep.id);
    }
  });
});
