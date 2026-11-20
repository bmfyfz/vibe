import { describe, expect, test } from "bun:test";

import { VibeError, type VibeHandle } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
const failing = (promise: Promise<unknown>) => promise.then(() => "no error", code);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A lead who plans the work, and two workers of the same person who do it. */
async function swarm() {
  const { client: ada, handle } = await vibe.join();
  return {
    handle,
    ada,
    lead: ada.as("lead"),
    fixer: ada.as("fixer"),
    tester: ada.as("tester"),
    channel: vibe.channel("work"),
  };
}

const state = async (client: VibeHandle, id: string) => (await client.tasks.get(id)).task.state;

/**
 * Someone who can read tasks and manages none of them. By default every member
 * holds `manage` everywhere, and whoever manages a task's channel can do what
 * its owner can, so it takes a viewer to see what ownership alone allows.
 */
const bystander = async () => (await vibe.join("viewer")).client;

describe("a task", () => {
  test("is a thread with a state, mirrored in a label nobody sets by hand", async () => {
    const { lead, channel } = await swarm();
    const { task, message } = await lead.tasks.create(channel, {
      text: "fix CVE-123 in acme/web",
      labels: { step: "fix" },
    });

    expect(task).toMatchObject({ id: message.id, channel, state: "ready", for: null, needs: [] });
    expect(task.owner.profile).toBe("lead");
    expect(message.labels).toEqual({ step: "fix", "vibe.task": "ready" });

    // It reads, lists and replies like any thread.
    const thread = await lead.thread(task.id);
    expect(thread.task).toMatchObject({ id: task.id, state: "ready" });
    await lead.reply(task.id, "context: the fix is in the lockfile");
    expect((await lead.threads({ channel, label: { "vibe.task": "ready" } })).threads).toHaveLength(
      1,
    );

    expect(await failing(lead.label(task.id, { set: { "vibe.task": "completed" } }))).toBe(
      "reserved_label",
    );
    expect(await failing(lead.tasks.get("msg_doesnotexist"))).toBe("task_not_found");
  });

  test("is claimed, worked in its thread, and completed with a result", async () => {
    const { lead, fixer, channel } = await swarm();
    const { cursor } = await lead.threads({ channel });
    const { task } = await lead.tasks.create(channel, "fix the flaky test");

    const claim = await fixer.tasks.claim(task.id);
    expect(claim?.task).toMatchObject({ state: "claimed", claimedBy: { profile: "fixer" } });
    expect(claim?.message.text).toBe("fix the flaky test");
    expect(Date.parse(claim?.claim.expiresAt ?? "")).toBeGreaterThan(Date.now());

    await fixer.reply(task.id, "patched, running the tests");
    const done = await claim?.complete("fixed in a1b2c3, tests pass");
    expect(done?.task).toMatchObject({
      state: "completed",
      result: "fixed in a1b2c3, tests pass",
      claimedBy: null,
    });
    expect(done?.message.labels["vibe.task"]).toBe("completed");

    const { events } = await lead.poll({ channel, after: cursor });
    expect(events.map((event) => event.type)).toEqual([
      "message.posted",
      "task.created",
      "task.claimed",
      "message.posted",
      "task.completed",
    ]);
    // A claim's ID is what settles the task. It never appears in the feed.
    expect(JSON.stringify(events)).not.toContain(claim?.claim.id ?? "clm_");
    expect(events.at(-1)?.payload).toEqual({ result: "fixed in a1b2c3, tests pass" });
  });

  test("goes to exactly one of the workers that claim it at once", async () => {
    const { ada, lead, channel } = await swarm();
    const { task } = await lead.tasks.create(channel, "only one of you");
    const workers = Array.from({ length: 5 }, (_, n) => ada.as(`worker-${n}`));

    const outcomes = await Promise.all(
      workers.map((worker) => worker.tasks.claim(task.id).then(() => "claimed", code)),
    );
    expect(outcomes.filter((outcome) => outcome === "claimed")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "task_claimed")).toHaveLength(4);
  });

  test("can be made of a thread that already exists", async () => {
    const { ada, lead, channel } = await swarm();
    const filed = await ada.post(channel, "checkout times out for EU cards");
    const { task } = await lead.tasks.adopt(filed.id);

    expect(task).toMatchObject({ id: filed.id, state: "ready" });
    expect(task.owner.profile).toBe("lead");
    expect((await lead.thread(filed.id)).message.by.profile).toBeNull();
    expect(await failing(lead.tasks.adopt(filed.id))).toBe("task_exists");
  });
});

describe("a claim's lease", () => {
  test("runs out: the task is ready for another worker, and the old claim changes nothing", async () => {
    const { lead, fixer, tester, channel } = await swarm();
    const { task } = await lead.tasks.create(channel, "takes too long");
    const stalled = await fixer.tasks.claim(task.id, { lease: 1 });
    await pause(1100);

    expect(await state(lead, task.id)).toBe("ready");
    expect(await failing(Promise.resolve(stalled?.complete("too late")))).toBe("claim_lost");
    expect(await failing(Promise.resolve(stalled?.renew()))).toBe("claim_lost");

    const taken = await tester.tasks.claim(task.id);
    expect(taken?.task.claimedBy?.profile).toBe("tester");
    expect(await failing(Promise.resolve(stalled?.release()))).toBe("claim_lost");
    expect((await taken?.complete())?.task.state).toBe("completed");
  });

  test("is kept by renewing it", async () => {
    const { lead, fixer, tester, channel } = await swarm();
    const { task } = await lead.tasks.create(channel, "long but alive");
    const claim = await fixer.tasks.claim(task.id, { lease: 1 });
    await pause(600);
    const until = await claim?.renew(2);
    expect(Date.parse(until ?? "")).toBeGreaterThan(Date.now() + 1000);
    await pause(700);

    // Past the first lease, inside the renewed one.
    expect(await failing(tester.tasks.claim(task.id))).toBe("task_claimed");
    expect((await claim?.complete())?.task.state).toBe("completed");
  });

  test("renewals stay out of the feed unless a follower asks for everything", async () => {
    const { lead, fixer, channel } = await swarm();
    const { task } = await lead.tasks.create(channel, "quiet renewals");
    const claim = await fixer.tasks.claim(task.id);
    await claim?.renew();

    const types = async (all: boolean) =>
      (await lead.poll({ re: task.id, after: task.id, all })).events.map((event) => event.type);
    expect(await types(false)).toEqual(["task.created", "task.claimed"]);
    expect(await types(true)).toEqual(["task.created", "task.claimed", "task.renewed"]);
  });

  test.skipIf(vibe.sweep === null)("a lapsed lease is recorded by the sweep", async () => {
    const { lead, fixer, channel } = await swarm();
    const { task } = await lead.tasks.create(channel, "abandoned");
    await fixer.tasks.claim(task.id, { lease: 1 });
    await pause(1100);

    expect((await vibe.sweep?.())?.expired).toBeGreaterThanOrEqual(1);
    const { message } = await lead.tasks.get(task.id);
    expect(message.labels["vibe.task"]).toBe("ready");
    const { events } = await lead.poll({ re: task.id, after: task.id });
    expect(events.at(-1)).toMatchObject({ type: "task.expired", actor: { profile: "fixer" } });
  });
});

describe("a queue", () => {
  test("hands out the oldest ready task that carries the labels asked for", async () => {
    const { lead, fixer, tester, channel } = await swarm();
    const [review, first, second] = await lead.tasks.createMany(`${channel}/web`, [
      { text: "review", labels: { step: "review" } },
      { text: "first fix", labels: { step: "fix" } },
      { text: "second fix", labels: { step: "fix" } },
    ]);

    const ready = { channel: `${channel}/`, label: { step: "fix" } };
    expect((await fixer.tasks.claim(ready))?.task.id).toBe(first?.task.id ?? "");
    expect((await tester.tasks.claim(ready))?.task.id).toBe(second?.task.id ?? "");
    expect(await fixer.tasks.claim(ready)).toBeNull();
    expect(
      (await lead.tasks.list({ channel: `${channel}/`, state: "ready" })).map((t) => t.task.id),
    ).toEqual([review?.task.id ?? ""]);
  });

  test("gives a worker the tasks kept for it first, and never another profile's", async () => {
    const { lead, fixer, tester, channel } = await swarm();
    const pooled = await lead.tasks.create(channel, "anyone");
    const kept = await lead.tasks.create(channel, { text: "deploy to production", for: "tester" });

    expect(await failing(fixer.tasks.claim(kept.task.id))).toBe("task_assigned");
    expect((await tester.tasks.claim({ channel }))?.task.id).toBe(kept.task.id);
    expect((await fixer.tasks.claim({ channel }))?.task.id).toBe(pooled.task.id);

    const returned = await lead.tasks.create(channel, { text: "was kept", for: "tester" });
    expect(await fixer.tasks.claim({ channel })).toBeNull();
    expect((await lead.tasks.assign(returned.task.id, null)).task.for).toBeNull();
    expect((await fixer.tasks.claim({ channel }))?.task.id).toBe(returned.task.id);
  });

  test("gives a worker only its own principal's tasks until it names other owners", async () => {
    const { lead, fixer, channel } = await swarm();
    const { client: bob } = await vibe.join();
    const { task } = await bob.tasks.create(channel, "a stranger's instructions");
    const mine = await lead.tasks.create(channel, "ours");

    expect((await fixer.tasks.claim({ channel }))?.task.id).toBe(mine.task.id);
    expect(await fixer.tasks.claim({ channel })).toBeNull();
    const taken = await fixer.tasks.claim({ channel, from: [task.owner.actor] });
    expect(taken?.task.id).toBe(task.id);
    expect(await failing(fixer.tasks.claim({ channel, from: ["bob"] }))).toBe("invalid_task");
  });

  test("makes a worker that waits take a task the moment one is ready", async () => {
    const { lead, fixer, channel } = await swarm();
    const waiting = fixer.tasks.claim({ channel, wait: 10 });
    await pause(50);
    const { task } = await lead.tasks.create(channel, "just in time");

    expect((await waiting)?.task.id).toBe(task.id);
    expect(await fixer.tasks.claim({ channel, wait: 0.1 })).toBeNull();
  });

  test("lists open tasks oldest first, and by state, owner and profile", async () => {
    const { handle, lead, fixer, channel } = await swarm();
    const a = await lead.tasks.create(channel, "a");
    const b = await lead.tasks.create(channel, { text: "b", for: "fixer" });
    const c = await fixer.tasks.create(channel, "c");
    await (await fixer.tasks.claim(a.task.id))?.complete();

    const ids = async (query: Parameters<VibeHandle["tasks"]["list"]>[0]) =>
      (await lead.tasks.list({ channel, ...query })).map((detail) => detail.task.id);
    expect(await ids({})).toEqual([b.task.id, c.task.id]);
    expect(await ids({ state: "all" })).toEqual([a.task.id, b.task.id, c.task.id]);
    expect(await ids({ state: "completed" })).toEqual([a.task.id]);
    expect(await ids({ for: "fixer" })).toEqual([b.task.id]);
    expect(await ids({ by: `${handle}/fixer` })).toEqual([c.task.id]);
    expect(await ids({ by: handle })).toEqual([b.task.id, c.task.id]);
  });
});

describe("tasks that wait for other tasks", () => {
  test("become ready when what they wait for completes, and not when it fails", async () => {
    const { lead, fixer, channel } = await swarm();
    const fix = await lead.tasks.create(channel, { text: "fix", labels: { step: "fix" } });
    const review = await lead.tasks.create(channel, { text: "review", needs: [fix.task.id] });
    expect(review.task).toMatchObject({ state: "waiting", needs: [fix.task.id] });
    expect(await failing(fixer.tasks.claim(review.task.id))).toBe("task_waiting");

    const attempt = await fixer.tasks.claim(fix.task.id);
    expect((await attempt?.fail("tests fail"))?.task).toMatchObject({
      state: "failed",
      reason: "tests fail",
    });
    expect(await state(lead, review.task.id)).toBe("waiting");

    // Retried in place, so what waits for it keeps waiting for the same task.
    expect(await failing((await bystander()).tasks.reopen(fix.task.id))).toBe("task_not_owned");
    expect((await lead.tasks.reopen(fix.task.id)).task.state).toBe("ready");
    await (await fixer.tasks.claim(fix.task.id))?.complete("fixed");

    const ready = await lead.tasks.get(review.task.id);
    expect(ready.task.state).toBe("ready");
    expect(ready.message.labels["vibe.task"]).toBe("ready");
    const { events } = await lead.poll({ re: review.task.id, after: review.task.id });
    expect(events.map((event) => event.type)).toEqual(["task.created", "task.ready"]);
  });

  test("a plan is created whole, each task waiting for the ones it names by key", async () => {
    const { lead, channel } = await swarm();
    const plan = [
      { text: "ship it", needs: [{ key: "review" }, { key: "fix" }], for: "shipper" },
      { key: "review", text: "review the fix", needs: [{ key: "fix" }] },
      { key: "fix", text: "fix CVE-123" },
    ];
    const [ship, review, fix] = await lead.tasks.createMany(channel, plan, {
      idempotencyKey: channel,
    });

    expect(fix?.task).toMatchObject({ state: "ready", needs: [] });
    expect(review?.task).toMatchObject({ state: "waiting", needs: [fix?.task.id ?? ""] });
    expect(ship?.task).toMatchObject({ state: "waiting", for: "shipper" });
    expect(new Set(ship?.task.needs)).toEqual(new Set([review?.task.id ?? "", fix?.task.id ?? ""]));

    // Written with the last step first, and still listed in the order given.
    const listed = await lead.tasks.list({ channel, state: "all" });
    expect(listed.map((detail) => detail.task.id)).toEqual(
      [ship, review, fix].map((detail) => detail?.task.id ?? ""),
    );

    // The same key and plan creates nothing more. The key with another plan is refused.
    const again = await lead.tasks.createMany(channel, plan, { idempotencyKey: channel });
    expect(again.map((detail) => detail.task.id)).toEqual(
      [ship, review, fix].map((d) => d?.task.id ?? ""),
    );
    expect((await lead.tasks.list({ channel })).length).toBe(3);
    expect(
      await failing(
        lead.tasks.createMany(channel, [{ text: "other" }], { idempotencyKey: channel }),
      ),
    ).toBe("duplicate_id");
  });

  test("a plan that can't be created creates none of it", async () => {
    const { lead, channel } = await swarm();
    const circle = [
      { key: "a", text: "a", needs: [{ key: "b" }] },
      { key: "b", text: "b", needs: [{ key: "a" }] },
    ];
    expect(await failing(lead.tasks.createMany(channel, circle))).toBe("invalid_needs");
    expect(await failing(lead.tasks.createMany(channel, [{ text: "ok" }, { text: "  " }]))).toBe(
      "invalid_message",
    );
    expect(await failing(lead.tasks.create(channel, { text: "x", needs: ["msg_nope"] }))).toBe(
      "invalid_needs",
    );
    expect(await lead.tasks.list({ channel, state: "all" })).toEqual([]);

    // A misspelled field is refused outright, so `need` can't create a task that waits for nothing.
    const response = await vibe.fetch(`${vibe.url}/v1/vibes/general/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: JSON.stringify({ channel, tasks: [{ text: "x", need: ["msg_1"] }] }),
    });
    expect([400, 401]).toContain(response.status);
  });

  test("a plan longer than one write is created in several, in order", async () => {
    const { lead, channel } = await swarm();
    // A chain of 17: each task waits for the one before it.
    const chain = Array.from({ length: 17 }, (_, n) => ({
      key: `step-${n}`,
      text: `step ${n}`,
      needs: n === 0 ? [] : [{ key: `step-${n - 1}` }],
    }));
    const created = await lead.tasks.createPlan(channel, chain, {
      idempotencyKey: `${channel}-chain`,
    });

    expect(created).toHaveLength(17);
    expect(created.map((detail) => detail.task.state)).toEqual([
      "ready",
      ...Array(16).fill("waiting"),
    ]);
    created.forEach((detail, n) => {
      expect(detail.task.needs).toEqual(n === 0 ? [] : [created[n - 1]?.task.id ?? ""]);
    });
    const again = await lead.tasks.createPlan(channel, chain, {
      idempotencyKey: `${channel}-chain`,
    });
    expect(again.map((d) => d.task.id)).toEqual(created.map((d) => d.task.id));
  });

  test("what a task waits for can be replaced, but tasks can't wait for each other", async () => {
    const { lead, fixer, channel } = await swarm();
    const a = await lead.tasks.create(channel, "a");
    const b = await lead.tasks.create(channel, { text: "b", needs: [a.task.id] });
    const c = await lead.tasks.create(channel, { text: "c", needs: [b.task.id] });

    expect(await failing(lead.tasks.needs(a.task.id, [c.task.id]))).toBe("invalid_needs");
    expect(await failing(lead.tasks.needs(a.task.id, [a.task.id]))).toBe("invalid_needs");
    expect(await failing((await bystander()).tasks.needs(c.task.id, []))).toBe("task_not_owned");

    expect((await lead.tasks.needs(c.task.id, [])).task).toMatchObject({
      state: "ready",
      needs: [],
    });
    expect((await lead.tasks.needs(c.task.id, [a.task.id])).task.state).toBe("waiting");
    await (await fixer.tasks.claim(a.task.id))?.complete();
    expect(await state(lead, c.task.id)).toBe("ready");
    expect(await state(lead, b.task.id)).toBe("ready");
  });
});

describe("a task's owner", () => {
  test("is asked by a worker that blocks the task, and lifts the hold", async () => {
    const { ada, lead, fixer, channel } = await swarm();
    const { task } = await lead.tasks.create(channel, "deploy acme/web to production");
    const claim = await fixer.tasks.claim(task.id);

    const held = await claim?.block("approve the prod deploy?", { kind: "awaiting_approval" });
    expect(held?.task).toMatchObject({
      state: "blocked",
      claimedBy: null,
      hold: { kind: "awaiting_approval", reason: "approve the prod deploy?" },
    });
    expect(await failing(Promise.resolve(claim?.complete()))).toBe("claim_lost");
    expect(await failing(fixer.tasks.claim(task.id))).toBe("task_blocked");

    await ada.reply(task.id, "approved, go ahead");
    expect(await failing((await bystander()).tasks.unblock(task.id))).toBe("task_not_owned");
    // A person manages what their profiles created.
    expect((await ada.tasks.unblock(task.id)).task).toMatchObject({ state: "ready", hold: null });
    expect((await fixer.tasks.claim(task.id))?.task.state).toBe("claimed");
  });

  test("can hold or cancel it at any time, which ends whatever claim there is", async () => {
    const { lead, fixer, channel } = await swarm();
    const { task } = await lead.tasks.create(channel, "superseded soon");
    const claim = await fixer.tasks.claim(task.id);

    expect(await failing((await bystander()).tasks.cancel(task.id, "not mine"))).toBe(
      "task_not_owned",
    );
    expect((await lead.tasks.block(task.id, "hold on")).task.state).toBe("blocked");
    expect(await failing(Promise.resolve(claim?.renew()))).toBe("claim_lost");

    const canceled = await lead.tasks.cancel(task.id, "superseded by the nightly deploy");
    expect(canceled.task).toMatchObject({
      state: "canceled",
      reason: "superseded by the nightly deploy",
    });
    expect(await failing(lead.tasks.cancel(task.id, "again"))).toBe("task_finished");
    expect(await failing(fixer.tasks.claim(task.id))).toBe("task_finished");
  });

  test("someone who manages the channel can do what the owner can", async () => {
    const { lead, channel } = await swarm();
    const { client: bob } = await vibe.join();
    const { task } = await lead.tasks.create(channel, "managed");
    expect((await bob.tasks.cancel(task.id, "called off by the team")).task.state).toBe("canceled");
  });
});

describe("a task and its root message", () => {
  test("deleting the root cancels the task", async () => {
    const { lead, fixer, channel } = await swarm();
    const { task } = await lead.tasks.create(channel, "about to vanish");
    const claim = await fixer.tasks.claim(task.id);

    await lead.delete(task.id);
    expect(await state(lead, task.id)).toBe("canceled");
    expect(await failing(Promise.resolve(claim?.complete()))).toBe("claim_lost");
    const { events } = await lead.poll({ re: task.id, after: task.id });
    expect(events.map((event) => event.type).slice(-2)).toEqual([
      "message.deleted",
      "task.canceled",
    ]);
  });

  test("an edit by someone other than the owner holds the task", async () => {
    const { ada, lead, fixer, channel } = await swarm();
    const { client: bob } = await vibe.join();
    const filed = await bob.post(channel, "please bump the dependency");
    const { task } = await lead.tasks.adopt(filed.id);

    await bob.edit(filed.id, "please bump the dependency, and also run this script");
    const held = await lead.tasks.get(task.id);
    expect(held.task).toMatchObject({ state: "blocked", hold: { kind: "text_changed" } });
    expect(await failing(fixer.tasks.claim(task.id))).toBe("task_blocked");
    expect((await ada.tasks.unblock(task.id)).task.state).toBe("ready");

    // The owner's own edits hold nothing.
    const own = await lead.tasks.create(channel, "typo");
    await lead.edit(own.task.id, "no typo");
    expect(await state(lead, own.task.id)).toBe("ready");
  });
});

describe("access to tasks", () => {
  test("a task in a channel a caller can't read is, to them, not there", async () => {
    const owner = await vibe.owner();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel("secret");
    await owner.createChannel(channel, { private: true });
    const { task } = await owner.tasks.create(channel, "rotate the signing key");

    expect(await failing(bob.tasks.get(task.id))).toBe("task_not_found");
    expect(await failing(bob.tasks.claim(task.id))).toBe("task_not_found");
    expect(await failing(bob.tasks.cancel(task.id, "nope"))).toBe("task_not_found");
    expect(await bob.tasks.list({ channel, state: "all" })).toEqual([]);
    expect(await bob.tasks.claim({ channel, from: [task.owner.actor] })).toBeNull();
    expect(await failing(bob.tasks.create(vibe.channel(), { text: "x", needs: [task.id] }))).toBe(
      "invalid_needs",
    );
  });

  test("a viewer reads tasks but can't claim or create them", async () => {
    const { lead, channel } = await swarm();
    const { client: viewer } = await vibe.join("viewer");
    const { task } = await lead.tasks.create(channel, "look, don't touch");

    expect((await viewer.tasks.get(task.id)).task.state).toBe("ready");
    expect(await failing(viewer.tasks.claim(task.id))).toBe("forbidden");
    expect(await failing(viewer.tasks.create(channel, "mine"))).toBe("forbidden");
  });
});

describe("tasks, where a first look would miss something", () => {
  test("two tasks made to wait for each other at once: one change lands, never both", async () => {
    const { lead, channel } = await swarm();
    for (let round = 0; round < 5; round++) {
      const a = await lead.tasks.create(channel, `a ${round}`);
      const b = await lead.tasks.create(channel, `b ${round}`);
      const results = await Promise.all([
        failing(lead.tasks.needs(a.task.id, [b.task.id])),
        failing(lead.tasks.needs(b.task.id, [a.task.id])),
      ]);
      expect(results.toSorted()).toEqual(["invalid_needs", "no error"]);
      // Whichever landed, the two don't wait for each other.
      const [afterA, afterB] = await Promise.all([
        lead.tasks.get(a.task.id),
        lead.tasks.get(b.task.id),
      ]);
      expect(afterA.task.needs.length + afterB.task.needs.length).toBe(1);
    }

    // A circle of three, closed from three sides at once, stays open somewhere.
    const [x, y, z] = await Promise.all(
      ["x", "y", "z"].map((text) => lead.tasks.create(channel, text)),
    );
    if (!x || !y || !z) throw new Error("The tasks were not created.");
    const closing = await Promise.all([
      failing(lead.tasks.needs(x.task.id, [y.task.id])),
      failing(lead.tasks.needs(y.task.id, [z.task.id])),
      failing(lead.tasks.needs(z.task.id, [x.task.id])),
    ]);
    expect(closing.filter((result) => result === "no error").length).toBeLessThan(3);
    expect(closing.filter((result) => result === "invalid_needs").length).toBeGreaterThan(0);
  });

  test("a ready task is found behind any number the worker may not take", async () => {
    const owner = await vibe.owner();
    const { ada, fixer } = await swarm();
    const area = vibe.channel("queue");
    // Over a hundred of her own tasks, older than the one she can still take.
    for (let batch = 0; batch < 7; batch++) {
      await ada.tasks.createMany(
        `${area}/closed`,
        Array.from({ length: 15 }, (_, n) => ({ text: `closed ${batch}-${n}` })),
      );
    }
    const open = await ada.tasks.create(`${area}/open`, "the one she can do");
    const grants = [
      await owner.createGrant({
        principals: [{ kind: "user", handle: (await owner.whoami()).actor.handle }],
        can: { [`${area}/closed`]: "all" },
      }),
      await owner.createGrant({
        principals: [{ kind: "everyone" }],
        can: { [`${area}/closed`]: "none" },
      }),
    ];
    try {
      expect(await ada.tasks.list({ channel: `${area}/closed` })).toEqual([]);
      const claimed = await fixer.tasks.claim({ channel: `${area}/` });
      expect(claimed?.task.id).toBe(open.task.id);
    } finally {
      for (const grant of grants) await owner.revokeGrant(grant.id);
    }
  });

  test("a deleted thread is not made a task", async () => {
    const { ada, lead } = await swarm();
    const root = await ada.post(vibe.channel("work"), "do this");
    await ada.delete(root.id);
    expect(await failing(lead.tasks.adopt(root.id))).toBe("message_deleted");
    expect(await failing(lead.tasks.get(root.id))).toBe("task_not_found");
  });

  test("a plan may wait for a hundred tasks", async () => {
    const { lead, channel } = await swarm();
    // A hundred tasks to wait for: more than one statement can name on D1.
    const earlier: string[] = [];
    for (let batch = 0; batch < 7; batch++) {
      const made = await lead.tasks.createMany(
        channel,
        Array.from({ length: 15 }, (_, n) => ({ text: `earlier ${batch}-${n}` })),
      );
      earlier.push(...made.map((each) => each.task.id));
    }
    const plan = Array.from({ length: 5 }, (_, n) => ({
      text: `waits for twenty, ${n}`,
      needs: earlier.slice(n * 20, n * 20 + 20),
    }));
    const waiting = await lead.tasks.createMany(channel, plan);
    expect(waiting.map((each) => each.task.needs.length)).toEqual([20, 20, 20, 20, 20]);
    expect(waiting.every((each) => each.task.state === "waiting")).toBe(true);
  });

  test("a plan may carry a hundred files", async () => {
    const { lead, channel } = await swarm();
    // Ten tasks with ten files each: again more than one statement can name on D1.
    const files: string[] = [];
    for (let n = 0; n < 100; n++) {
      files.push((await lead.upload({ name: `note-${n}.txt`, data: `note ${n}` })).id);
    }
    const plan = Array.from({ length: 10 }, (_, n) => ({
      text: `with ten files, ${n}`,
      attachments: files.slice(n * 10, n * 10 + 10),
    }));
    const made = await lead.tasks.createMany(channel, plan);
    expect(made.map((each) => each.message.attachments.length)).toEqual(
      Array.from({ length: 10 }, () => 10),
    );
  });
});
