import { afterAll, describe, expect, test } from "bun:test";

import { type Grant, VibeError, type VibeHandle } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
const status = (error: unknown) => (error instanceof VibeError ? error.status : -1);

describe("the API's root", () => {
  test("says what it is, at /v1 itself as under it", async () => {
    const root = await vibe.fetch(`${vibe.url}/v1`);
    expect(root.headers.get("content-type")).toContain("application/json");
    expect(await root.json()).toEqual({ name: "vibe", api: "v1" });
    expect((await vibe.fetch(`${vibe.url}/v1/login`)).headers.get("content-type")).toContain(
      "application/json",
    );
  });
});

describe("identity", () => {
  test("whoami reports the caller behind the token", async () => {
    const { handle, client } = await vibe.join();
    const me = await client.whoami();
    expect(me.actor.handle).toBe(handle);
    expect(me.actor.actor).toStartWith("vibe:user:u_");
    expect(me.team.name).toBe("default");
  });

  test("a request without a valid token is refused", async () => {
    const anonymous = await vibe.fetch(`${vibe.url}/v1/whoami`);
    expect(anonymous.status).toBe(401);
    expect(((await anonymous.json()) as { code: string }).code).toBe("unauthorized");

    const forged = await vibe.fetch(`${vibe.url}/v1/whoami`, {
      headers: { authorization: "Bearer vibe_sk_not-a-real-token" },
    });
    expect(forged.status).toBe(401);
  });

  test("operator routes need the deployment's secret", async () => {
    const response = await vibe.fetch(`${vibe.url}/v1/admin/users`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ handle: "mallory" }),
    });
    expect(response.status).toBe(403);
  });

  test("a viewer reads but can't post", async () => {
    const { client: ada } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const channel = vibe.channel();
    const root = await ada.post(channel, "hello");

    expect((await viewer.thread(root.id)).message.text).toBe("hello");
    const error = await viewer.reply(root.id, "hi").catch((e) => e);
    expect([code(error), status(error)]).toEqual(["forbidden", 403]);
  });
});

describe("profiles", () => {
  test("an agent names itself, and writes as a profile of whoever holds the token", async () => {
    const { handle, client: ada } = await vibe.join();
    const fx = ada.as("fx");

    const me = await fx.whoami();
    expect(me.actor).toMatchObject({ handle: `${handle}/fx`, name: "fx", profile: "fx" });
    expect(me.actor.actor).toBe(`${me.actor.principal}+fx`);

    // The first write introduces the profile. Until then nobody lists it.
    const handles = async () => (await ada.actors()).map((actor) => actor.handle);
    expect(await handles()).toContain(handle);
    expect(await handles()).not.toContain(`${handle}/fx`);

    const root = await fx.post(vibe.channel(), "the deploy is green");
    expect(root.by).toMatchObject({ handle: `${handle}/fx`, profile: "fx" });
    expect(await handles()).toContain(`${handle}/fx`);

    // Names match regardless of case, so this is the same actor.
    const reply = await ada.as("FX").reply(root.id, "still green");
    expect(reply.by.actor).toBe(root.by.actor);
  });

  test("a person's handle covers their agents in filters, and a profile's handle is exact", async () => {
    const { handle, client: ada } = await vibe.join();
    const channel = vibe.channel();
    await ada.post(channel, "from ada");
    await ada.as("fx").post(channel, "from fx");
    await ada.as("codex").post(channel, "from codex");
    const texts = async (by: string, as = ada) =>
      (await as.threads({ channel, by })).threads.map((t) => t.message.text).sort();

    expect(await texts(handle)).toEqual(["from ada", "from codex", "from fx"]);
    expect(await texts("me")).toEqual(["from ada", "from codex", "from fx"]);
    expect(await texts(`${handle}/fx`)).toEqual(["from fx"]);
    expect(await texts("me", ada.as("fx"))).toEqual(["from fx"]);
  });

  test("a profile name that isn't one is refused", async () => {
    const { client } = await vibe.join();
    for (const name of ["1fx", "f x", "x".repeat(33), "fx/1"]) {
      const error = await client
        .as(name)
        .whoami()
        .catch((e) => e);
      expect([name, code(error), status(error)]).toEqual([name, "invalid_profile", 400]);
    }
  });
});

describe("threads", () => {
  test("a post starts a thread, and the first post creates the channel", async () => {
    const { handle, client } = await vibe.join();
    const channel = vibe.channel("dev");

    const root = await client.post(channel, "deploys are **green** again");
    expect(root).toMatchObject({ channel, text: "deploys are **green** again", re: null });
    expect(root.id).toStartWith("msg_");
    expect(root.by.handle).toBe(handle);

    expect((await client.channels()).map((c) => c.path)).toContain(channel);
    const { threads } = await client.threads({ channel });
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ message: { id: root.id }, replies: 0, last: null });
  });

  test("replies join the thread from any message in it, in order", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel();

    const root = await ada.post(channel, "checkout times out");
    const first = await bob.reply(root.id, "on it");
    const second = await ada.reply(first.id, "thanks");

    expect(first).toMatchObject({ re: root.id, replyTo: null });
    expect(second).toMatchObject({ re: root.id, replyTo: first.id });

    for (const id of [root.id, second.id]) {
      const thread = await ada.thread(id);
      expect(thread.message.id).toBe(root.id);
      expect(thread.replies.map((reply) => reply.text)).toEqual(["on it", "thanks"]);
    }
    const [summary] = (await ada.threads({ channel })).threads;
    expect(summary).toMatchObject({ replies: 2, last: { id: second.id } });
  });

  test("a channel with a trailing slash reads its whole subtree", async () => {
    const { client } = await vibe.join();
    const base = vibe.channel("www");
    await client.post(`${base}/production`, "prod");
    await client.post(`${base}/preview`, "preview");
    await client.post(`${base}x`, "a sibling, not a child");

    const texts = (await client.threads({ channel: `${base}/` })).threads.map(
      (t) => t.message.text,
    );
    expect(texts.sort()).toEqual(["preview", "prod"]);
  });

  test("filters by author", async () => {
    const { handle, client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel();
    await ada.post(channel, "from ada");
    await bob.post(channel, "from bob");

    const mine = (await ada.threads({ channel, by: "me" })).threads;
    const byHandle = (await bob.threads({ channel, by: handle })).threads;
    expect(mine.map((t) => t.message.text)).toEqual(["from ada"]);
    expect(byHandle.map((t) => t.message.text)).toEqual(["from ada"]);
  });

  test("a person's handle covers their profiles, and =handle is the person alone", async () => {
    const { handle, client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel();
    const asked = await ada.as("fx").post(channel, "asked by ada's agent");
    await ada.post(channel, "written by ada");

    const threads = async (by: string, as = bob) =>
      (await as.threads({ channel, by })).threads.map((t) => t.message.text).sort();
    expect(await threads(handle)).toEqual(["asked by ada's agent", "written by ada"]);
    expect(await threads(`=${handle}`)).toEqual(["written by ada"]);
    expect(await threads(`=@${handle.toUpperCase()}`)).toEqual(["written by ada"]);
    expect(await threads("=me", ada)).toEqual(["written by ada"]);
    expect(await threads(`=${handle}/fx`)).toEqual(["asked by ada's agent"]);
    expect(await threads(`=${asked.by.actor}`)).toEqual(["asked by ada's agent"]);

    // What an agent waits on for its person's answer: the thread it asked in
    // was written by a profile of that person, and so are its own replies.
    await ada.as("fx").reply(asked.id, "still waiting");
    const answer = await ada.reply(asked.id, "go ahead");
    const said = async (by: string) =>
      (await bob.poll({ re: asked.id, by, after: asked.id })).events.map((e) => e.message?.id);
    expect((await said(handle)).length).toBe(2);
    expect(await said(`=${handle}`)).toEqual([answer.id]);
  });

  test("bad input is refused with a reason", async () => {
    const { client } = await vibe.join();
    const failures = await Promise.all([
      client.post("Not A Channel", "x").catch((e) => e),
      client.post(vibe.channel(), "   ").catch((e) => e),
      client.reply("msg_doesnotexist", "x").catch((e) => e),
      client.thread("msg_doesnotexist").catch((e) => e),
    ]);
    expect(failures.map(code)).toEqual([
      "invalid_channel",
      "invalid_message",
      "message_not_found",
      "message_not_found",
    ]);
    expect(failures.map(status)).toEqual([400, 400, 404, 404]);
  });

  test("a malformed request body says which field is wrong", async () => {
    const { token } = await vibe.join();
    const response = await vibe.fetch(`${vibe.url}/v1/vibes/general/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "dev", re: "msg_1", text: 5 }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_request");
    expect(body.message).toContain("text");
  });

  test("an unknown vibe is not found, and general always exists", async () => {
    const { client, token } = await vibe.join();
    expect((await client.vibes()).map((p) => p.name)).toContain("general");
    const response = await vibe.fetch(`${vibe.url}/v1/vibes/nope/channels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("vibe_not_found");
  });
});

describe("writing safely", () => {
  test("a reply with `after` lands only while that message is the newest", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "is the refresh endpoint safe to cache?");
    const first = await client.reply(root.id, "yes", { after: root.id });

    const stale = await client.reply(root.id, "no", { after: root.id }).catch((e) => e);
    expect([code(stale), status(stale)]).toEqual(["newer_message", 409]);
    expect((await client.thread(root.id)).replies.map((r) => r.id)).toEqual([first.id]);
  });

  test("an idempotency key posts once", async () => {
    const { client } = await vibe.join();
    const channel = vibe.channel();
    const key = `deploy-${channel}`;

    const once = await client.post(channel, "www@a1b2c3 is live", { idempotencyKey: key });
    const again = await client.post(channel, "www@a1b2c3 is live", { idempotencyKey: key });
    expect(again.id).toBe(once.id);
    expect((await client.threads({ channel })).threads).toHaveLength(1);

    const elsewhere = await client
      .post(vibe.channel(), "other", { idempotencyKey: key })
      .catch((e) => e);
    expect(code(elsewhere)).toBe("duplicate_id");
  });

  test("the same key sent concurrently still posts once", async () => {
    const { client } = await vibe.join();
    const channel = vibe.channel();
    const posts = await Promise.all(
      Array.from({ length: 5 }, () => client.post(channel, "once", { idempotencyKey: channel })),
    );
    expect(new Set(posts.map((post) => post.id)).size).toBe(1);
    expect((await client.threads({ channel })).threads).toHaveLength(1);
  });

  test("concurrent replies all land, each at its own place", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "roll call");
    const replies = await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.reply(root.id, `worker ${i}`)),
    );

    const thread = await client.thread(root.id);
    expect(thread.replies).toHaveLength(6);
    expect(new Set(thread.replies.map((r) => r.id))).toEqual(new Set(replies.map((r) => r.id)));
  });
});

describe("labels", () => {
  test("a message holds one value per key, set on the post or afterwards", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "deploy failed on a1b2c3", {
      labels: { status: "open" },
    });
    expect(root.labels).toEqual({ status: "open" });

    const triaged = await client.label(root.id, { set: { status: "triaged", "dup-of": "640" } });
    expect(triaged?.labels).toEqual({ status: "triaged", "dup-of": "640" });
    expect((await client.label(root.id, { unset: ["status"] }))?.labels).toEqual({
      "dup-of": "640",
    });

    const reply = await client.reply(root.id, "same as 640", { labels: { kind: "note" } });
    expect((await client.thread(root.id)).replies[0]?.labels).toEqual({ kind: "note" });
    // Labels are not an edit: the revision stays.
    expect((await client.label(reply.id, { set: { kind: "dup" } }))?.revision).toBe(reply.revision);
  });

  test("bad and reserved labels are refused", async () => {
    const { client } = await vibe.join();
    const channel = vibe.channel();
    const root = await client.post(channel, "x");
    const failures = await Promise.all([
      client.label(root.id, { set: { "vibe.task": "ready" } }).catch((e) => e),
      client.post(channel, "y", { labels: { "vibe.task": "ready" } }).catch((e) => e),
      client.label(root.id, { set: { "Not A Key": "1" } }).catch((e) => e),
      client.label(root.id, { set: { k: "v".repeat(257) } }).catch((e) => e),
      client.label("msg_doesnotexist", { set: { k: "v" } }).catch((e) => e),
      client.threads({ channel, label: "Not A Key" }).catch((e) => e),
    ]);
    expect(failures.map(code)).toEqual([
      "reserved_label",
      "reserved_label",
      "invalid_label",
      "invalid_label",
      "message_not_found",
      "invalid_label",
    ]);
    expect(failures.map(status)).toEqual([400, 400, 400, 400, 404, 400]);
    expect((await client.thread(root.id)).message.labels).toEqual({});
  });

  test("a conditional change lands only while the labels are as expected", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "bug", { labels: { state: "open" } });

    await client.label(root.id, { set: { state: "fixing" }, if: { state: "open" } });
    const stale = await client
      .label(root.id, { set: { state: "wontfix" }, if: { state: "open" } })
      .catch((e) => e);
    expect([code(stale), status(stale)]).toEqual(["label_conflict", 409]);
    // The reason names the label, never what it holds.
    expect((stale as Error).message).toContain("state");
    expect((stale as Error).message).not.toContain("fixing");

    await client.label(root.id, { set: { reviewer: "fx" }, if: { reviewer: null } });
    const taken = await client
      .label(root.id, { set: { reviewer: "codex" }, if: { reviewer: null } })
      .catch((e) => e);
    expect(code(taken)).toBe("label_conflict");
    expect((await client.thread(root.id)).message.labels).toEqual({
      state: "fixing",
      reviewer: "fx",
    });
  });

  test("of many writers racing on one condition, exactly one lands", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "who takes this?", {
      labels: { state: "open" },
    });
    const workers = Array.from({ length: 8 }, (_, i) => `worker-${i}`);

    const results = await Promise.all(
      workers.map((worker) =>
        client
          .as(worker)
          .label(root.id, { set: { owner: worker, state: "taken" }, if: { state: "open" } })
          .then(() => worker, code),
      ),
    );
    const winners = results.filter((result) => workers.includes(result));
    const winner = winners[0] ?? "";
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => result === "label_conflict")).toHaveLength(7);
    expect((await client.thread(root.id)).message.labels).toEqual({
      owner: winner,
      state: "taken",
    });

    // One change was recorded, by the winner, however many tried.
    const { events } = await client.poll({ re: root.id, after: root.id });
    expect(events.map((e) => [e.type, e.actor.profile])).toEqual([["labels.changed", winner]]);
  });

  test("unconditional changes to different labels all land, whatever the order", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "tag me");
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => client.label(root.id, { set: { [`k${i}`]: `v${i}` } })),
    );
    expect(Object.keys((await client.thread(root.id)).message.labels).sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `k${i}`),
    );
  });

  test("read filters by key, by value, by several values, and by several labels", async () => {
    const { client } = await vibe.join();
    const channel = vibe.channel();
    const open = await client.post(channel, "open bug", { labels: { state: "open", kind: "bug" } });
    const draft = await client.post(channel, "draft", { labels: { state: "draft" } });
    const plain = await client.post(channel, "no labels");
    // A label on any message puts its thread in view.
    await client.reply(plain.id, "tagged reply", { labels: { kind: "bug" } });

    const ids = async (label: string | string[] | Record<string, string>) =>
      (await client.threads({ channel, label })).threads.map((t) => t.message.id).sort();
    expect(await ids("state")).toEqual([open.id, draft.id].sort());
    expect(await ids("state=open")).toEqual([open.id]);
    expect(await ids("state=open|draft")).toEqual([open.id, draft.id].sort());
    expect(await ids({ state: "open", kind: "bug" })).toEqual([open.id]);
    expect(await ids(["state=draft", "kind"])).toEqual([]);
    expect(await ids("kind=bug")).toEqual([open.id, plain.id].sort());
  });

  test("following a label shows a message enter the view, and leave it", async () => {
    const { client } = await vibe.join();
    const channel = vibe.channel();
    const { cursor } = await client.poll({ channel });

    const bug = await client.post(channel, "checkout times out", { labels: { state: "open" } });
    await client.post(channel, "unrelated");
    const reply = await client.reply(bug.id, "on it");
    await client.label(bug.id, { set: { state: "closed" }, unset: ["nothing"] });
    await client.reply(bug.id, "after closing");
    await client.label(bug.id, { set: { owner: "fx" } });

    const followed = await client.poll({ channel, label: "state=open", after: cursor });
    expect(followed.events.map((e) => [e.type, e.message?.id])).toEqual([
      ["message.posted", bug.id],
      // A root's labels count for every message in its thread.
      ["message.posted", reply.id],
      // The change that closes it matched before, so the follower sees it go.
      ["labels.changed", bug.id],
    ]);
    expect(followed.events[2]?.payload).toEqual({ set: { state: "closed" }, unset: [] });

    const closed = await client.poll({ channel, label: ["state=closed"], after: cursor });
    expect(closed.events.map((e) => e.type)).toEqual([
      "labels.changed",
      "message.posted",
      "labels.changed",
    ]);
    // Both conditions must hold on one side of a change, not one on each.
    const both = await client.poll({ channel, label: ["state=open", "owner"], after: cursor });
    expect(both.events).toEqual([]);
  });

  test("a message takes sixty-four labels from its first post, and a label of any name", async () => {
    const { client } = await vibe.join();
    const channel = vibe.channel();
    const many = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, n) => [`k${n}`, "v"]));
    expect(code(await client.post(channel, "too many", { labels: many(65) }).catch((e) => e))).toBe(
      "invalid_label",
    );
    const full = await client.post(channel, "as many as it holds", { labels: many(64) });
    // What it was posted with can still be changed.
    expect((await client.label(full.id, { set: { k0: "changed" } }))?.labels["k0"]).toBe("changed");

    // A key that every object answers to is a key like any other.
    const root = await client.post(channel, "named for anything", {
      labels: { constructor: "ada" },
    });
    expect(root.labels).toEqual({ constructor: "ada" });
    expect(
      code(
        await client
          .label(root.id, { set: { tostring: "x" }, if: { tostring: "y" } })
          .catch((e) => e),
      ),
    ).toBe("label_conflict");
    const changed = await client.label(root.id, {
      set: { constructor: "bob" },
      if: { constructor: "ada", valueof: null },
    });
    expect(changed?.labels).toEqual({ constructor: "bob" });
    const found = await client.threads({ channel, label: "constructor=bob" });
    expect(found.threads.map((each) => each.message.id)).toEqual([root.id]);
    await client.react(root.id, "constructor");
    expect((await client.thread(root.id)).message.reactions).toMatchObject([
      { emoji: "constructor" },
    ]);
  });

  test("wait returns when a label is set", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const root = await ada.post(vibe.channel(), "needs review");

    const waiting = ada.wait({ re: root.id, label: "review=approved", after: root.id });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bob.label(root.id, { set: { review: "changes" } });
    await bob.label(root.id, { set: { review: "approved" } });

    const event = await waiting;
    expect(event?.type).toBe("labels.changed");
    expect(event?.message?.labels).toMatchObject({ review: "approved" });
  });

  test("a viewer can't label", async () => {
    const { client: ada } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const root = await ada.post(vibe.channel(), "hello");
    const error = await viewer.label(root.id, { set: { seen: "yes" } }).catch((e) => e);
    expect([code(error), status(error)]).toEqual(["forbidden", 403]);
  });
});

describe("reactions", () => {
  test("each actor reacts with an emoji once, and can take it back", async () => {
    const { handle: adaHandle, client: ada } = await vibe.join();
    const { handle: vicHandle, client: vic } = await vibe.join("viewer");
    const root = await ada.post(vibe.channel(), "shipping at noon");
    const { cursor } = await ada.poll({ re: root.id });

    await ada.react(root.id, "eyes");
    await ada.react(root.id, ":eyes:");
    // A viewer can't post, and can still react.
    await vic.react(root.id, "👀");
    const both = await ada.as("fx").react(root.id, "👍");
    expect(both?.reactions).toEqual([
      {
        emoji: "eyes",
        by: [
          expect.objectContaining({ handle: adaHandle }),
          expect.objectContaining({ handle: vicHandle }),
        ],
      },
      { emoji: "thumbs_up", by: [expect.objectContaining({ handle: `${adaHandle}/fx` })] },
    ]);
    // Reactions are not an edit.
    expect(both?.revision).toBe(root.revision);

    const after = await ada.react(root.id, "eyes", { remove: true });
    expect(after?.reactions[0]).toMatchObject({ emoji: "eyes", by: [{ handle: vicHandle }] });
    await ada.react(root.id, "eyes", { remove: true });

    const { events } = await ada.poll({ re: root.id, after: cursor });
    expect(events.map((e) => [e.type, e.payload["emoji"], e.actor.handle])).toEqual([
      ["reaction.added", "eyes", adaHandle],
      ["reaction.added", "eyes", vicHandle],
      ["reaction.added", "thumbs_up", `${adaHandle}/fx`],
      ["reaction.removed", "eyes", adaHandle],
    ]);
  });

  test("something that isn't an emoji is refused", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "x");
    const failures = await Promise.all([
      client.react(root.id, "not an emoji").catch((e) => e),
      client.react("msg_doesnotexist", "eyes").catch((e) => e),
    ]);
    expect(failures.map(code)).toEqual(["invalid_emoji", "message_not_found"]);
    expect(failures.map(status)).toEqual([400, 404]);
  });
});

describe("editing and deleting", () => {
  test("an edit replaces the text and changes the revision", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "deploys are gren", {
      labels: { kind: "note" },
    });
    expect(root.revision).toBe(1);

    const edited = await client.edit(root.id, "deploys are green", { revision: root.revision });
    expect(edited).toMatchObject({
      text: "deploys are green",
      revision: 2,
      labels: { kind: "note" },
    });

    const stale = await client
      .edit(root.id, "too late", { revision: root.revision })
      .catch((e) => e);
    expect([code(stale), status(stale)]).toEqual(["revision_conflict", 409]);
    expect(code(await client.edit(root.id, "   ").catch((e) => e))).toBe("invalid_message");
    // Writing the text it already has changes nothing.
    expect((await client.edit(root.id, "deploys are green"))?.revision).toBe(2);

    const { events } = await client.poll({ re: root.id, after: root.id });
    expect(events.map((e) => [e.type, e.payload["revision"], e.message?.text])).toEqual([
      ["message.edited", 2, "deploys are green"],
    ]);
  });

  test("only the author edits or deletes, and a profile only what it wrote", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel();
    const byAda = await ada.post(channel, "from ada");
    const byFx = await ada.as("fx").post(channel, "from fx");

    const refused = await Promise.all([
      bob.edit(byAda.id, "bob was here").catch((e) => e),
      bob.delete(byAda.id).catch((e) => e),
      ada
        .as("codex")
        .edit(byFx.id, "codex was here")
        .catch((e) => e),
      ada
        .as("fx")
        .edit(byAda.id, "fx was here")
        .catch((e) => e),
      ada
        .as("fx")
        .delete(byAda.id)
        .catch((e) => e),
    ]);
    expect(refused.map(code)).toEqual(Array.from({ length: 5 }, () => "forbidden"));
    expect(refused.map(status)).toEqual(Array.from({ length: 5 }, () => 403));

    expect((await ada.as("fx").edit(byFx.id, "fx fixed it"))?.text).toBe("fx fixed it");
    // As yourself, you can change what your profiles wrote.
    expect((await ada.edit(byFx.id, "ada fixed it"))?.text).toBe("ada fixed it");
    expect((await ada.delete(byFx.id))?.deletedAt).toBeString();
  });

  test("two edits from the same revision: exactly one lands", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "draft");
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        client.edit(root.id, `version ${i}`, { revision: 1 }).then((m) => m?.text, code),
      ),
    );
    expect(results.filter((result) => result === "revision_conflict")).toHaveLength(4);
    const { message } = await client.thread(root.id);
    expect(message.revision).toBe(2);
    expect(results).toContain(message.text);
  });

  test("a deleted message becomes a tombstone, and its replies stay", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel();
    const file = await ada.upload({ name: "secret.txt", data: "not for long" });
    const root = await ada.post(channel, "oops, wrong channel", {
      labels: { state: "open" },
      attachments: [file.id],
    });
    const reply = await bob.reply(root.id, "what was that?");
    await bob.react(root.id, "eyes");
    const { cursor } = await ada.poll({ channel });

    const stale = await ada.delete(root.id, { revision: 9 }).catch((e) => e);
    expect(code(stale)).toBe("revision_conflict");
    const gone = await ada.delete(root.id, { revision: root.revision });
    expect(gone).toMatchObject({
      id: root.id,
      text: "",
      labels: {},
      reactions: [],
      attachments: [],
      revision: 2,
    });
    expect(gone?.deletedAt).toBeString();
    // Deleting it again does nothing.
    expect((await ada.delete(root.id))?.revision).toBe(2);

    const thread = await bob.thread(reply.id);
    expect(thread.message.deletedAt).not.toBeNull();
    expect(thread.replies.map((r) => r.text)).toEqual(["what was that?"]);
    // Label filters no longer find it, and the change that removed it reached
    // whoever followed the label.
    expect((await ada.threads({ channel, label: "state=open" })).threads).toEqual([]);
    const followed = await ada.poll({ channel, label: "state=open", after: cursor });
    expect(followed.events.map((e) => e.type)).toEqual(["message.deleted"]);

    // Its file is gone from every view. The uploader can still fetch it by ID.
    expect(await (await ada.download(file.id)).response.text()).toBe("not for long");

    const changes = await Promise.all([
      ada.edit(root.id, "back again").catch((e) => e),
      ada.label(root.id, { set: { state: "open" } }).catch((e) => e),
      bob.react(root.id, "eyes").catch((e) => e),
    ]);
    expect(changes.map(code)).toEqual(["message_deleted", "message_deleted", "message_deleted"]);
    expect(changes.map(status)).toEqual([400, 400, 400]);
    expect((await bob.reply(root.id, "still here")).re).toBe(root.id);
  });

  test("a team owner can delete what others wrote, and can't edit it", async () => {
    const { client: member } = await vibe.join();
    const owner = await vibe.owner();
    const root = await member.post(vibe.channel(), "spam");

    expect(code(await owner.edit(root.id, "not spam").catch((e) => e))).toBe("forbidden");
    // As a profile the owner is an agent like any other, held to what it wrote.
    expect(
      code(
        await owner
          .as("bot")
          .delete(root.id)
          .catch((e) => e),
      ),
    ).toBe("forbidden");
    expect((await owner.delete(root.id))?.deletedAt).toBeString();
  });
});

describe("mentions", () => {
  test("a handle one visible actor has becomes a mention of that actor", async () => {
    const { handle: adaHandle, client: ada } = await vibe.join();
    const { handle: bobHandle, client: bob } = await vibe.join();
    const channel = vibe.channel();
    const fx = (await ada.as("fx").post(channel, "fx reporting in")).by;
    const bobId = (await bob.whoami()).actor.actor;

    const root = await ada.post(
      channel,
      `@${bobHandle} ready to promote? cc @${adaHandle}/fx and @nobody-${channel}`,
    );
    expect(root.text).toBe(
      `@[${bobId}] ready to promote? cc @[${fx.actor}] and @nobody-${channel}`,
    );
    expect(root.mentions).toEqual([
      { actor: bobId, handle: bobHandle, name: bobHandle },
      { actor: fx.actor, handle: `${adaHandle}/fx`, name: "fx" },
    ]);
    // A handle no one has stays text. The write still lands, and says so.
    expect(root.unresolved).toEqual([`@nobody-${channel}`]);

    const exact = await bob.reply(root.id, `on it, @[${fx.actor}]. \`@${adaHandle}\` is code`);
    expect(exact.mentions.map((m) => m.handle)).toEqual([`${adaHandle}/fx`]);
    expect(exact.unresolved).toEqual([]);
  });

  test("read, wait and tail find the messages that mention someone", async () => {
    const { handle: adaHandle, client: ada } = await vibe.join();
    const { handle: bobHandle, client: bob } = await vibe.join();
    const channel = vibe.channel();
    const fx = ada.as("fx");
    await fx.post(channel, "fx is here");
    const { cursor } = await ada.poll({ channel });

    const waiting = fx.wait({ channel, mentions: "me", after: cursor }, { timeout: "10s" });
    await bob.post(channel, "nothing to see");
    const forAda = await bob.post(channel, `@${adaHandle} this one is for you`);
    const forFx = await bob.post(channel, `over to @${adaHandle}/fx`);

    // A profile has its own mentions: one of its person is not one of it.
    expect((await waiting)?.message?.id).toBe(forFx.id);

    const mentioning = async (who: string, as = bob) =>
      (await as.threads({ channel, mentions: who })).threads.map((t) => t.message.id);
    expect(await mentioning("me", ada)).toEqual([forAda.id]);
    expect(await mentioning(adaHandle)).toEqual([forAda.id]);
    expect(await mentioning(`@${adaHandle}/fx`)).toEqual([forFx.id]);
    expect(await mentioning(forFx.mentions[0]?.actor ?? "")).toEqual([forFx.id]);
    expect(await mentioning(bobHandle)).toEqual([]);
    expect(await mentioning("no-such-handle")).toEqual([]);
  });

  test("an edit settles mentions again, and reaches whoever it stops mentioning", async () => {
    const { client: ada } = await vibe.join();
    const { handle: bobHandle, client: bob } = await vibe.join();
    const { handle: carolHandle, client: carol } = await vibe.join();
    const channel = vibe.channel();
    const root = await ada.post(channel, `@${bobHandle} can you review?`);

    const edited = await ada.edit(root.id, `@${carolHandle} can you review? @ghost-${channel}`);
    expect(edited?.mentions.map((m) => m.handle)).toEqual([carolHandle]);
    expect(edited?.unresolved).toEqual([`@ghost-${channel}`]);

    const seenBy = async (client: typeof bob) =>
      (await client.poll({ channel, mentions: "me", after: root.id })).events.map((e) => e.type);
    expect(await seenBy(bob)).toEqual(["message.edited"]);
    expect(await seenBy(carol)).toEqual(["message.edited"]);
    expect((await bob.threads({ channel, mentions: "me" })).threads).toEqual([]);

    // A deleted message mentions no one.
    await ada.delete(root.id);
    expect((await carol.threads({ channel, mentions: "me" })).threads).toEqual([]);
    expect(await seenBy(carol)).toEqual(["message.edited", "message.deleted"]);
  });

  test("a mention is made by what is written, not by what happens to it after", async () => {
    const { client: ada } = await vibe.join();
    const { handle: bobHandle, client: bob } = await vibe.join();
    const channel = vibe.channel();
    await ada.post(channel, "before any of it");
    const { cursor } = await bob.poll({ channel });
    const { task } = await ada.tasks.create(channel, `@${bobHandle} this one is yours`);

    // Everything else that can happen to a message that mentions bob.
    await ada.label(task.id, { set: { review: "approved" } });
    await ada.react(task.id, "eyes");
    const claim = await bob.as("worker").tasks.claim(task.id);
    await claim?.complete("done");

    const seen = async (filter: { label?: string }) =>
      (await bob.poll({ channel, mentions: "me", after: cursor, ...filter })).events.map(
        (e) => e.type,
      );
    expect(await seen({})).toEqual(["message.posted"]);
    // A label asked for beside the mention is still seen when it is set.
    expect(await seen({ label: "review=approved" })).toEqual(["labels.changed"]);

    const waiting = bob.wait({ channel, mentions: "me", after: task.id }, { timeout: "10s" });
    await ada.label(task.id, { set: { review: "again" } });
    const reply = await ada.reply(task.id, `@${bobHandle} one more thing`);
    expect((await waiting)?.message?.id).toBe(reply.id);
  });
});

describe("grants", () => {
  // Every test here works in a subtree of its own, so the grants it makes
  // touch nothing else. They are revoked at the end, to keep a vibe that is
  // tested again and again from collecting them.
  const made: string[] = [];
  const keep = (...grants: Grant[]) => {
    made.push(...grants.map((grant) => grant.id));
    return grants;
  };
  afterAll(async () => {
    const owner = await vibe.owner();
    for (const id of made) await owner.revokeGrant(id).catch(() => {});
  });
  const user = (handle: string) => ({ kind: "user" as const, handle });
  const everyone = { kind: "everyone" as const };

  /** Opens `<area>/` to some people and closes it to everyone else. */
  async function closed(owner: VibeHandle, area: string, ...handles: string[]) {
    const [mine] = keep(
      await owner.createGrant({ principals: handles.map(user), can: { [`${area}/`]: "all" } }),
    );
    keep(await owner.createGrant({ principals: [everyone], can: { [`${area}/`]: "none" } }));
    return mine as Grant;
  }

  test("a vibe starts open to the whole team, as far as each role allows", async () => {
    const { handle, client: member } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const channel = vibe.channel();

    expect((await member.whoami()).can?.["*"]).toEqual([
      "read",
      "post",
      "react",
      "label",
      "sync",
      "manage",
    ]);
    expect((await viewer.whoami()).can?.["*"]).toEqual(["read", "react"]);
    expect(await member.explain(channel)).toMatchObject({
      channel,
      principal: { handle },
      role: "member",
      pattern: "*",
      grants: ["g1"],
      can: ["read", "post", "react", "label", "sync", "manage"],
    });
    // The role caps what the grant gives.
    expect(await viewer.explain(channel)).toMatchObject({
      granted: ["read", "post", "react", "label", "sync", "manage"],
      can: ["read", "react"],
    });
    expect((await member.grants()).find((grant) => grant.id === "g1")).toEqual({
      id: "g1",
      principals: [{ kind: "all-users" }],
      can: { "*": ["read", "post", "react", "label", "sync", "manage"] },
    });
  });

  test("the most specific pattern wins, then the closest principal, and ties add up", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { handle: bob, client: asBob } = await vibe.join();
    const { handle: vic, client: asVic } = await vibe.join("viewer");
    const area = vibe.channel("sec");
    const incidents = `${area}/incidents`;

    const insiders = await closed(owner, area, alice, vic);
    expect(insiders.principals).toEqual([
      expect.objectContaining({ kind: "user", handle: alice }),
      expect.objectContaining({ kind: "user", handle: vic }),
    ]);

    // Alice is named at security/, which is closer than everyone.
    const root = await asAlice.post(incidents, "pager went off");
    // Bob's access at * doesn't get him in: the more specific pattern decides first.
    expect(await asBob.explain(incidents)).toMatchObject({ pattern: `${area}/`, can: [] });
    expect(code(await asBob.post(incidents, "hello?").catch((e) => e))).toBe("forbidden");
    // The viewer is let in, and the role still caps what that means.
    expect((await asVic.thread(root.id)).message.text).toBe("pager went off");
    expect(code(await asVic.reply(root.id, "hi").catch((e) => e))).toBe("forbidden");

    // Two grants that name Bob himself at the same pattern add up.
    keep(await owner.createGrant({ principals: [user(bob)], can: { [`${area}/`]: ["read"] } }));
    keep(await owner.createGrant({ principals: [user(bob)], can: { [`${area}/`]: ["react"] } }));
    const explained = await asBob.explain(incidents);
    expect(explained.can).toEqual(["read", "react"]);
    expect(explained.grants).toHaveLength(2);
    await asBob.react(root.id, "eyes");
    expect(code(await asBob.reply(root.id, "on it").catch((e) => e))).toBe("forbidden");

    // An exact channel is more specific than the subtree, for everyone it names.
    const faq = `${area}/faq`;
    keep(await owner.createGrant({ principals: [everyone], can: { [faq]: ["read", "post"] } }));
    expect((await asBob.explain(faq)).can).toEqual(["read", "post"]);
    expect((await asAlice.explain(faq)).can).toEqual(["read", "post"]);
    expect((await asBob.post(faq, "how do I page someone?")).channel).toBe(faq);
    expect((await asBob.whoami()).can).toMatchObject({
      "*": ["read", "post", "react", "label", "sync", "manage"],
      [`${area}/`]: ["read", "react"],
      [faq]: ["read", "post"],
    });
  });

  test("what a caller can't read is not there for them: lists, events, IDs and files", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { client: asBob } = await vibe.join();
    const area = vibe.channel("vault");
    const open = vibe.channel();
    const { cursor } = await asBob.poll();
    await closed(owner, area, alice);

    const file = await asAlice.upload({ name: "keys.txt", data: "hunter2" });
    const secret = await asAlice.as("keeper").post(`${area}/keys`, "rotation is due", {
      attachments: [file.id],
      labels: { state: "open" },
    });
    await asAlice.reply(secret.id, "done");
    const visible = await asAlice.post(open, "nothing secret here");

    // Lists leave it out.
    expect((await asBob.channels()).map((c) => c.path)).not.toContain(`${area}/keys`);
    expect((await asAlice.channels()).map((c) => c.path)).toContain(`${area}/keys`);
    expect((await asBob.threads({ channel: `${area}/` })).threads).toEqual([]);
    expect((await asBob.threads({ label: "state=open", by: alice })).threads).toEqual([]);
    expect((await asAlice.threads({ channel: `${area}/` })).threads).toHaveLength(1);

    // The feed skips it, and the cursor still moves past it.
    const page = await asBob.poll({ after: cursor });
    const seen = page.events.map((e) => e.message?.id);
    expect(seen).toContain(visible.id);
    expect(seen).not.toContain(secret.id);
    expect((await asBob.poll({ channel: `${area}/`, after: cursor })).events).toEqual([]);
    expect((await asAlice.poll({ channel: `${area}/`, after: cursor })).events).toHaveLength(2);

    // By ID it is not found, whatever is tried, so nothing confirms it exists.
    const attempts = await Promise.all([
      asBob.thread(secret.id).catch((e) => e),
      asBob.reply(secret.id, "what's this?").catch((e) => e),
      asBob.label(secret.id, { set: { seen: "yes" } }).catch((e) => e),
      asBob.react(secret.id, "eyes").catch((e) => e),
      asBob.edit(secret.id, "mine now").catch((e) => e),
      asBob.delete(secret.id).catch((e) => e),
      asBob.poll({ after: secret.id }).catch((e) => e),
      asBob.threads({ after: secret.id }).catch((e) => e),
    ]);
    expect(attempts.map(code)).toEqual(Array.from({ length: 8 }, () => "message_not_found"));
    expect(code(await asBob.download(file.id).catch((e) => e))).toBe("attachment_not_found");

    // An agent that has only written there is unknown to him, and its handle stays text.
    const keeper = `${alice}/keeper`;
    expect((await asAlice.actors()).map((a) => a.handle)).toContain(keeper);
    expect((await asBob.actors()).map((a) => a.handle)).not.toContain(keeper);
    const asked = await asBob.post(open, `@${keeper} are you there? @${alice} is.`);
    expect(asked.mentions.map((m) => m.handle)).toEqual([alice]);
    expect(asked.unresolved).toEqual([`@${keeper}`]);

    // A key he has used elsewhere tells him nothing here either.
    await asBob.post(open, "keyed", { idempotencyKey: `key-${area}` });
    const replayed = await Promise.all([
      asBob.reply(secret.id, "again", { idempotencyKey: `key-${area}` }).catch((e) => e),
      asBob.reply("msg_doesnotexist", "again", { idempotencyKey: `key-${area}` }).catch((e) => e),
    ]);
    expect(replayed.map(code)).toEqual(["message_not_found", "message_not_found"]);
    // Nor does his own access list name what is closed to him.
    const named = async (client: VibeHandle) =>
      Object.keys((await client.whoami()).can ?? {}).filter((pattern) => pattern.startsWith(area));
    expect(await named(asBob)).toEqual([]);
    expect(await named(asAlice)).toEqual([`${area}/`]);

    // A deleted message's file is for its uploader, and for whoever reads every channel.
    await asAlice.as("keeper").delete(secret.id);
    expect(code(await asBob.delete(secret.id).catch((e) => e))).toBe("message_not_found");
    expect(await (await asAlice.download(file.id)).response.text()).toBe("hunter2");
    expect(code(await asBob.download(file.id).catch((e) => e))).toBe("attachment_not_found");
  });

  test("a read reaches what's visible past any amount that isn't", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { client: asBob } = await vibe.join();
    const area = vibe.channel("busy");
    await closed(owner, `${area}/hidden`, alice);
    const { cursor } = await asBob.poll({ channel: `${area}/` });

    // More hidden threads than a read looks at in one go, between two visible ones.
    const older = await asAlice.post(`${area}/open`, "older, visible");
    for (let batch = 0; batch < 7; batch++) {
      await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          asAlice.post(`${area}/hidden/logs`, `hidden ${batch * 15 + i}`),
        ),
      );
    }
    const newer = await asAlice.post(`${area}/open`, "newer, visible");

    const listed = await asBob.threads({ channel: `${area}/`, limit: 2 });
    expect(listed.threads.map((t) => t.message.id)).toEqual([newer.id, older.id]);
    expect((await asAlice.threads({ channel: `${area}/`, limit: 500 })).threads).toHaveLength(107);

    // One event at a time, as `wait` asks: the cursor steps over the hidden
    // ones without skipping the visible one behind them.
    const first = await asBob.poll({ channel: `${area}/`, after: cursor, limit: 1 });
    expect(first.events.map((e) => e.message?.id)).toEqual([older.id]);
    const second = await asBob.poll({ channel: `${area}/`, after: first.cursor, limit: 1 });
    expect(second.events.map((e) => e.message?.id)).toEqual([newer.id]);
    expect((await asBob.poll({ channel: `${area}/`, after: second.cursor })).events).toEqual([]);
    const waited = await asBob.wait({ channel: `${area}/`, after: older.id }, { timeout: "5s" });
    expect(waited?.message?.id).toBe(newer.id);
  });

  test("label or react without read makes the change, and shows nothing of the message", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { handle: bot, client: asBot } = await vibe.join();
    const area = vibe.channel("triage");
    await closed(owner, area, alice);
    keep(
      await owner.createGrant({
        principals: [user(bot)],
        can: { [`${area}/`]: ["label", "react"] },
      }),
    );
    const root = await asAlice.post(`${area}/inbox`, "customer data inside", {
      labels: { state: "new" },
    });

    expect(await asBot.label(root.id, { set: { state: "seen" }, if: { state: "new" } })).toBeNull();
    expect(await asBot.react(root.id, "eyes")).toBeNull();
    const stale = await asBot
      .label(root.id, { set: { state: "x" }, if: { state: "new" } })
      .catch((e) => e);
    expect(code(stale)).toBe("label_conflict");
    expect((stale as Error).message).not.toContain("seen");
    expect(code(await asBot.thread(root.id).catch((e) => e))).toBe("message_not_found");

    const { message } = await asAlice.thread(root.id);
    expect(message.labels).toEqual({ state: "seen" });
    expect(message.reactions).toMatchObject([{ emoji: "eyes", by: [{ handle: bot }] }]);
  });

  test("changing a grant takes manage there, and gives no more than you have", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { handle: bob, client: asBob } = await vibe.join();
    const { client: asVic } = await vibe.join("viewer");
    const area = vibe.channel("ops");
    const insiders = await closed(owner, area, alice);

    // Bob holds manage at * and not in the closed subtree.
    const refused = await Promise.all([
      asBob.createGrant({ principals: [user(bob)], can: { [`${area}/`]: "all" } }).catch((e) => e),
      asBob.updateGrant(insiders.id, { add: [user(bob)] }).catch((e) => e),
      asBob.revokeGrant(insiders.id).catch((e) => e),
      // Closing a channel to everyone, and changing g1, are for owners.
      asBob
        .createGrant({ principals: [everyone], can: { [vibe.channel()]: "none" } })
        .catch((e) => e),
      asBob.updateGrant("g1", { can: { "*": ["read"] } }).catch((e) => e),
      asBob.revokeGrant("g1").catch((e) => e),
      // A viewer's role allows no manage anywhere.
      asVic.grants().catch((e) => e),
      asVic
        .createGrant({ principals: [user(bob)], can: { [vibe.channel()]: "all" } })
        .catch((e) => e),
      asVic.explain(area, { user: bob }).catch((e) => e),
    ]);
    expect(refused.map(code)).toEqual(Array.from({ length: 9 }, () => "forbidden"));
    expect(refused.map(status)).toEqual(Array.from({ length: 9 }, () => 403));

    // Alice has everything in the subtree, so she can let Bob in, a part at a time.
    const [forBob] = keep(
      await asAlice.createGrant({
        principals: [user(bob)],
        can: { [`${area}/`]: ["read", "post"] },
      }),
    );
    expect((await asBob.post(`${area}/deploys`, "shipped")).channel).toBe(`${area}/deploys`);
    // He still can't hand out what he wasn't given.
    const beyond = await asBob
      .createGrant({ principals: [user(bob)], can: { [`${area}/x`]: ["read"] } })
      .catch((e) => e);
    expect(code(beyond)).toBe("forbidden");

    const invalid = await Promise.all([
      asAlice
        .createGrant({ principals: [user("no-such-person")], can: { [area]: "all" } })
        .catch((e) => e),
      asAlice
        .createGrant({ principals: [user(bob)], can: { "Not A Channel": "all" } })
        .catch((e) => e),
      asAlice.updateGrant(forBob?.id ?? "", { remove: [user(bob)] }).catch((e) => e),
      asAlice.revokeGrant("g999999").catch((e) => e),
      asAlice.revokeGrant("nonsense").catch((e) => e),
    ]);
    expect(invalid.map(code)).toEqual([
      "user_not_found",
      "invalid_channel",
      "invalid_grant",
      "grant_not_found",
      "grant_not_found",
    ]);
  });

  test("a change to a grant applies from the next request", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { handle: bob, client: asBob } = await vibe.join();
    const area = vibe.channel("team");
    const insiders = await closed(owner, area, alice);
    const root = await asAlice.post(`${area}/standup`, "blocked on review");
    const reads = () =>
      asBob.thread(root.id).then(
        () => true,
        () => false,
      );

    expect(await reads()).toBe(false);
    const widened = await owner.updateGrant(insiders.id, { add: [user(bob)] });
    expect(widened.principals.map((p) => (p.kind === "user" ? p.handle : p.kind))).toEqual([
      alice,
      bob,
    ]);
    expect(await reads()).toBe(true);

    await owner.updateGrant(insiders.id, { can: { [`${area}/`]: ["post"] } });
    expect(await reads()).toBe(false);
    // With post alone a caller starts threads, and can't answer what it can't read.
    expect((await asBob.post(`${area}/intake`, "feedback")).channel).toBe(`${area}/intake`);
    expect(code(await asBob.reply(root.id, "me too").catch((e) => e))).toBe("message_not_found");

    await owner.updateGrant(insiders.id, { can: { [`${area}/`]: "all" }, remove: [user(bob)] });
    expect(await reads()).toBe(false);
    await owner.revokeGrant(insiders.id);
    expect(code(await asAlice.thread(root.id).catch((e) => e))).toBe("message_not_found");
    // The owner can't read it either, and can always change the grants to.
    expect(code(await owner.thread(root.id).catch((e) => e))).toBe("message_not_found");
    const me = (await owner.whoami()).actor.handle;
    keep(await owner.createGrant({ principals: [user(me)], can: { [`${area}/`]: "all" } }));
    expect((await owner.thread(root.id)).message.id).toBe(root.id);
  });

  test("changes to one grant made at once all land", async () => {
    const owner = await vibe.owner();
    const people = await Promise.all(Array.from({ length: 5 }, () => vibe.join()));
    const area = vibe.channel("crowd");
    const [grant] = keep(
      await owner.createGrant({ principals: [everyone], can: { [`${area}/`]: ["read"] } }),
    );

    await Promise.all(
      people.map(({ handle }) => owner.updateGrant(grant?.id ?? "", { add: [user(handle)] })),
    );
    const after = (await owner.grants()).find((candidate) => candidate.id === grant?.id);
    const named = after?.principals.flatMap((p) => (p.kind === "user" ? [p.handle] : []));
    expect(named?.sort()).toEqual(people.map(({ handle }) => handle).sort());
  });

  test("explaining someone else's access takes manage at *", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { handle: bob } = await vibe.join();
    const area = vibe.channel("hr");
    await closed(owner, area, alice);

    expect(await asAlice.explain(`${area}/reviews`, { user: bob })).toMatchObject({
      principal: { handle: bob },
      pattern: `${area}/`,
      can: [],
    });
    expect(await owner.explain(`${area}/reviews`, { user: alice })).toMatchObject({
      pattern: `${area}/`,
      can: ["read", "post", "react", "label", "sync", "manage"],
    });
    expect(code(await owner.explain(area, { user: "no-such-person" }).catch((e) => e))).toBe(
      "user_not_found",
    );
  });

  test("a private channel is closed to everyone but its creator, until they let others in", async () => {
    const { handle: alice, client: asAlice } = await vibe.join();
    const { handle: bob, client: asBob } = await vibe.join();
    const path = vibe.channel("private");
    const { cursor } = await asAlice.poll();

    const made = await asAlice.createChannel(path, { private: true });
    const [mine, closing] = keep(...(made.grants ?? []));
    expect(made).toMatchObject({ channel: { path }, created: true });
    expect(mine).toMatchObject({
      principals: [{ kind: "user", handle: alice }],
      can: { [path]: ["read", "post", "react", "label", "sync", "manage"] },
    });
    expect(closing).toMatchObject({
      principals: [{ kind: "everyone" }],
      can: { [`${path}/`]: [] },
    });

    const root = await asAlice.post(path, "just me here");
    await asAlice.post(`${path}/notes`, "and under it");
    expect((await asAlice.channels()).map((c) => c.path)).toContain(path);
    expect((await asBob.channels()).map((c) => c.path)).not.toContain(path);
    expect(code(await asBob.thread(root.id).catch((e) => e))).toBe("message_not_found");
    expect(code(await asBob.post(`${path}/notes`, "let me in").catch((e) => e))).toBe("forbidden");
    // Even the event that created it reaches only those who can read it.
    const types = async (client: VibeHandle) =>
      (await client.poll({ channel: path, after: cursor })).events.map((e) => e.type);
    expect(await types(asAlice)).toEqual(["channel.created", "message.posted"]);
    expect(await types(asBob)).toEqual([]);

    await asAlice.updateGrant(mine?.id ?? "", { add: [user(bob)] });
    expect((await asBob.reply(root.id, "thanks")).re).toBe(root.id);

    // Nothing is created over a channel that exists, or under a path a grant
    // already reaches: that grant would still let in whoever it names.
    const granted = vibe.channel("private");
    keep(
      await asAlice.createGrant({ principals: [user(bob)], can: { [`${granted}/inner`]: "all" } }),
    );
    const refusals = await Promise.all([
      asBob.createChannel(path, { private: true }).catch((e) => e),
      asAlice.createChannel(`${path}/notes`, { private: true }).catch((e) => e),
      asAlice.createChannel(granted, { private: true }).catch((e) => e),
    ]);
    expect(refusals.map(code)).toEqual(["channel_exists", "channel_exists", "channel_granted"]);
    expect(refusals.map(status)).toEqual([409, 409, 409]);
    expect((await asAlice.channels()).map((c) => c.path)).not.toContain(granted);

    // A broader grant doesn't stand in the way: the new, more specific one decides first.
    const nested = await Promise.all([
      asBob.createChannel(`${granted}/elsewhere`, { private: true }),
      asAlice.createChannel(`${path}/annex`, { private: true }),
    ]);
    keep(...nested.flatMap((made) => made.grants ?? []));
    expect(nested.map((made) => made.created)).toEqual([true, true]);

    // It takes manage at *, which a viewer's role never gives, and manage at
    // the path: nobody carves a channel out of a subtree that is closed to them.
    const { client: viewer } = await vibe.join("viewer");
    const refused = await viewer
      .createChannel(vibe.channel("private"), { private: true })
      .catch((e) => e);
    expect(code(refused)).toBe("forbidden");

    // Refused before anything is said about the path, so it can't be used to
    // ask whether a channel exists.
    const probe = await viewer.createChannel(path, { private: true }).catch((e) => e);
    expect(code(probe)).toBe("forbidden");

    const owner = await vibe.owner();
    const shut = vibe.channel("shut");
    keep(await owner.createGrant({ principals: [everyone], can: { [`${shut}/`]: "none" } }));
    const squat = await asBob.createChannel(`${shut}/mine`, { private: true }).catch((e) => e);
    expect([code(squat), status(squat)]).toEqual(["forbidden", 403]);
  });

  test("a wait that outlives a change to the grants follows the change", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { handle: bob, client: asBob } = await vibe.join();
    const pause = () => new Promise((resolve) => setTimeout(resolve, 150));

    // A channel made private while he waits is closed to him from then on.
    const hush = vibe.channel("hush");
    const { cursor } = await asBob.poll({ channel: hush });
    const waiting = asBob.poll({ channel: hush, after: cursor, wait: 2 });
    await pause();
    keep(...((await asAlice.createChannel(hush, { private: true })).grants ?? []));
    await asAlice.post(hush, "between us");
    expect((await waiting).events).toEqual([]);

    // A channel opened to him while he waits is seen, and his cursor doesn't pass it by.
    const area = vibe.channel("late");
    const insiders = await closed(owner, area, alice);
    const from = (await asBob.poll({ channel: `${area}/` })).cursor;
    const listening = asBob.poll({ channel: `${area}/`, after: from, wait: 5 });
    await pause();
    await owner.updateGrant(insiders.id, { add: [user(bob)] });
    const welcome = await asAlice.post(`${area}/room`, "welcome, bob");
    expect((await listening).events.map((e) => e.message?.id)).toEqual([welcome.id]);
  });

  test("a retried post comes back as it was written to someone who can no longer read it", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { client: asBob } = await vibe.join();
    const area = vibe.channel("intake");
    const options = { idempotencyKey: `report-${area}`, labels: { kind: "report" } };
    const report = await asBob.post(`${area}/reports`, "build 512 failed", options);

    await closed(owner, area, alice);
    await asAlice.label(report.id, { set: { verdict: "flaky" } });
    await asAlice.react(report.id, "eyes");

    const again = await asBob.post(`${area}/reports`, "build 512 failed", options);
    expect(again).toMatchObject({
      id: report.id,
      text: "build 512 failed",
      labels: {},
      reactions: [],
    });
    expect((await asAlice.thread(report.id)).message.labels).toEqual({
      kind: "report",
      verdict: "flaky",
    });
  });

  test("a plan sent again comes back as it was made to someone who can no longer read it", async () => {
    const owner = await vibe.owner();
    const { handle: alice, client: asAlice } = await vibe.join();
    const { client: asBob } = await vibe.join();
    const area = vibe.channel("queue");
    const plan = [
      { key: "fix", text: "fix the build" },
      { text: "ship it", needs: [{ key: "fix" }] },
    ];
    const key = { idempotencyKey: `plan-${area}` };
    const [fix, ship] = await asBob.tasks.createMany(`${area}/work`, plan, key);
    if (!fix || !ship) throw new Error("The plan made no tasks.");

    // Bob is shut out, and the work goes on without him.
    await closed(owner, area, alice);
    const held = await asAlice.tasks.claim(fix.task.id);
    await held?.complete("fixed: the deploy key is hunter2");
    await asAlice.label(ship.task.id, { set: { verdict: "risky" } });
    await asAlice.react(ship.task.id, "eyes");
    expect((await asAlice.tasks.get(ship.task.id)).task.state).toBe("ready");

    // His retry is answered with what he made, and nothing that was done to it since.
    const again = await asBob.tasks.createMany(`${area}/work`, plan, key);
    expect(again.map((each) => each.task.id)).toEqual([fix.task.id, ship.task.id]);
    expect(again[0]?.task).toMatchObject({
      state: "ready",
      result: null,
      claimedBy: null,
      leaseExpiresAt: null,
    });
    expect(again[1]?.task).toMatchObject({ state: "waiting", needs: [fix.task.id] });
    expect(again[1]?.message).toMatchObject({ text: "ship it", labels: {}, reactions: [] });
    const said = JSON.stringify(again);
    for (const kept of ["hunter2", "risky", "completed"]) expect(said).not.toContain(kept);
    // Whoever reads the channel is shown the tasks as they stand.
    expect((await asAlice.tasks.get(fix.task.id)).task).toMatchObject({
      state: "completed",
      result: "fixed: the deploy key is hunter2",
    });
  });

  test("a channel can be created before anything posts to it", async () => {
    const { client } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const path = vibe.channel("alerts");
    const { cursor } = await client.poll();

    expect(await client.createChannel(path)).toMatchObject({ channel: { path }, created: true });
    expect(await client.createChannel(path)).toMatchObject({ channel: { path }, created: false });
    expect((await client.channels()).map((c) => c.path)).toContain(path);
    expect((await client.threads({ channel: path })).threads).toEqual([]);

    const { events } = await client.poll({ channel: path, after: cursor });
    expect(events.map((e) => [e.type, e.message])).toEqual([["channel.created", null]]);
    expect(code(await viewer.createChannel(vibe.channel()).catch((e) => e))).toBe("forbidden");
    expect(code(await client.createChannel("Not A Channel").catch((e) => e))).toBe(
      "invalid_channel",
    );
  });

  test("two private channels created at once each get their own pair of grants", async () => {
    const { client } = await vibe.join();
    const paths = Array.from({ length: 4 }, () => vibe.channel("race"));
    const results = await Promise.all(
      paths.map((path) => client.createChannel(path, { private: true })),
    );
    const ids = results.flatMap((result) =>
      keep(...(result.grants ?? [])).map((grant) => grant.id),
    );
    expect(new Set(ids).size).toBe(8);
  });
});

describe("events", () => {
  test("a read's cursor leads to exactly what came after it", async () => {
    const { client } = await vibe.join();
    const channel = vibe.channel();
    const before = await client.post(channel, "before");
    const { cursor } = await client.threads({ channel });

    const root = await client.post(channel, "after");
    const reply = await client.reply(root.id, "a reply");

    const page = await client.poll({ channel, after: cursor });
    expect(page.events.map((e) => [e.type, e.message?.id])).toEqual([
      ["message.posted", root.id],
      ["message.posted", reply.id],
    ]);
    expect(page.events.map((e) => e.message?.id)).not.toContain(before.id);
    expect((await client.poll({ channel, after: page.cursor })).events).toEqual([]);

    const fresh = (await client.threads({ channel, after: cursor })).threads;
    expect(fresh.map((t) => t.message.id)).toEqual([root.id]);
  });

  test("a message ID is a cursor too", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "question");
    const answer = await client.reply(root.id, "answer");

    const page = await client.poll({ re: root.id, after: root.id });
    expect(page.events.map((e) => e.message?.id)).toEqual([answer.id]);
    expect(code(await client.poll({ after: "nonsense" }).catch((e) => e))).toBe("invalid_cursor");
  });

  test("filters narrow the feed, and the cursor still moves past what didn't match", async () => {
    const { client } = await vibe.join();
    const [here, there] = [vibe.channel(), vibe.channel()];
    const { cursor } = await client.poll();
    await client.post(there, "elsewhere");

    const quiet = await client.poll({ channel: here, after: cursor });
    expect(quiet.events).toEqual([]);
    expect(quiet.cursor).not.toBe(cursor);

    await client.post(here, "here");
    const page = await client.poll({ channel: here, after: quiet.cursor });
    expect(page.events.map((e) => e.message?.text)).toEqual(["here"]);
  });

  test("wait blocks until an answer arrives, and counts one that already has", async () => {
    const { client: ada } = await vibe.join();
    const { handle, client: bob } = await vibe.join();
    const root = await ada.post(vibe.channel(), "ready to promote?");

    const waiting = ada.wait({ re: root.id, after: root.id }, { timeout: "10s" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const answer = await bob.reply(root.id, "ship it");

    const event = await waiting;
    expect(event?.message?.id).toBe(answer.id);
    expect(event?.actor.handle).toBe(handle);

    // The answer is already there, so this returns at once.
    const again = await ada.wait({ re: root.id, after: root.id }, { timeout: "10s" });
    expect(again?.message?.id).toBe(answer.id);
  });

  test("wait gives up after its timeout", async () => {
    const { client } = await vibe.join();
    const root = await client.post(vibe.channel(), "anyone?");
    expect(await client.wait({ re: root.id, after: root.id }, { timeout: 150 })).toBeNull();
  });
});

describe("attachments", () => {
  test("a file is uploaded, posted, listed and downloaded intact", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const bytes = crypto.getRandomValues(new Uint8Array(64 * 1024));

    const file = await ada.upload({ name: "trace.bin", data: bytes, type: "application/x-trace" });
    expect(file).toMatchObject({
      name: "trace.bin",
      type: "application/x-trace",
      size: bytes.length,
    });
    expect(file.id).toStartWith("att_");

    // A message can be all attachment and no text.
    const root = await ada.post(vibe.channel(), "", { attachments: [file.id] });
    expect(root.attachments).toEqual([file]);
    expect((await bob.thread(root.id)).message.attachments).toEqual([file]);

    const download = await bob.download(file.id);
    expect(download).toMatchObject({ name: "trace.bin", type: "application/x-trace" });
    expect(download.response.headers.get("content-disposition")).toStartWith("attachment");
    expect(new Uint8Array(await download.response.arrayBuffer())).toEqual(bytes);
  });

  test("a file is served as bytes, never as something a page could run", async () => {
    const { client: ada } = await vibe.join();
    const script = await ada.upload({
      name: "x.js",
      type: "text/javascript",
      data: new TextEncoder().encode("alert(1)"),
    });
    const picture = await ada.upload({
      name: "x.png",
      type: "image/png",
      data: new Uint8Array([137, 80, 78, 71]),
    });
    await ada.post(vibe.channel(), "", { attachments: [script.id, picture.id] });

    // A script someone uploaded shares the page's origin. Served as a script,
    // the page's own policy would let it load.
    const served = await ada.download(script.id);
    expect(served.type).toBe("text/javascript");
    expect(served.response.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(served.response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    // A picture is served as one, so the web app can show it.
    expect((await ada.download(picture.id)).response.headers.get("content-type")).toBe("image/png");
  });

  test("a post carries only its author's own files, and a file joins one message", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel();
    const file = await ada.upload({ name: "notes.md", data: "# notes" });

    // Until it's posted, only the uploader can read it or post it.
    expect(code(await bob.download(file.id).catch((e) => e))).toBe("attachment_not_found");
    expect(
      code(await bob.post(channel, "mine now", { attachments: [file.id] }).catch((e) => e)),
    ).toBe("attachment_not_found");

    await ada.post(channel, "see attached", { attachments: [file.id] });
    expect(await (await bob.download(file.id)).response.text()).toBe("# notes");
    expect(code(await ada.post(channel, "again", { attachments: [file.id] }).catch((e) => e))).toBe(
      "attachment_not_found",
    );
  });

  test("two posts racing for one file: exactly one gets it", async () => {
    const { client } = await vibe.join();
    const channel = vibe.channel();
    const file = await client.upload({ name: "one.txt", data: "only once" });

    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        client.post(channel, `post ${n}`, { attachments: [file.id] }).catch(code),
      ),
    );
    expect(results.filter((result) => typeof result !== "string")).toHaveLength(1);
    expect(results.filter((result) => result === "attachment_not_found")).toHaveLength(2);
    expect((await client.threads({ channel })).threads).toHaveLength(1);
  });

  test("an upload needs a name and a body", async () => {
    const { client, token } = await vibe.join();
    expect(code(await client.upload({ name: "empty.txt", data: "" }).catch((e) => e))).toBe(
      "invalid_attachment",
    );
    const unnamed = await vibe.fetch(`${vibe.url}/v1/vibes/general/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-length": "2" },
      body: "hi",
    });
    expect(unnamed.status).toBe(400);
  });
});
