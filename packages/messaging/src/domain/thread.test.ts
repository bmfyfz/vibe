import { describe, expect, test } from "bun:test";

import { DomainError, parseChannelPath } from "@vibe/kernel";

import { normalizeEmoji } from "./emoji.ts";
import type { LabelChange } from "./label.ts";
import { settleMentions, writtenLength } from "./mentions.ts";
import { type Editor, MAX_TEXT_LENGTH } from "./message.ts";
import { Thread } from "./thread.ts";

const channel = parseChannelPath("dev");
const ada = "vibe:user:u_ada";
const start = (text = "deploy failed") =>
  Thread.start({ id: "msg_1", vibeId: "vb_1", channel, actorId: ada, text, now: 100 });
const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
};

describe("Thread", () => {
  test("a post starts a thread whose root is that message", () => {
    const thread = start();
    expect(thread.isNew).toBe(true);
    expect(thread.snapshot).toMatchObject({ id: "msg_1", version: 1, replyCount: 0 });

    const [event] = thread.pullEvents();
    expect(event).toMatchObject({
      type: "message.posted",
      threadId: "msg_1",
      threadVersion: 1,
      message: { id: "msg_1", replyTo: null, position: 1 },
    });
    expect(thread.pullEvents()).toEqual([]);
  });

  test("replies join the thread in order, each with the next version", () => {
    const thread = start();
    thread.pullEvents();
    const a = thread.reply({
      id: "msg_2",
      actorId: ada,
      text: "on it",
      inReplyTo: "msg_1",
      now: 200,
    });
    const b = thread.reply({
      id: "msg_3",
      actorId: ada,
      text: "fixed",
      inReplyTo: "msg_2",
      now: 300,
    });

    expect([a.position, b.position]).toEqual([2, 3]);
    expect(a.replyTo).toBeNull();
    expect(b.replyTo).toBe("msg_2");
    expect(thread.snapshot).toMatchObject({
      version: 3,
      replyCount: 2,
      lastMessageId: "msg_3",
      lastActivityAt: 300,
    });
    expect(thread.pullEvents().map((e) => e.threadVersion)).toEqual([2, 3]);
  });

  test("a reply with `after` lands only while that message is the newest", () => {
    const thread = start();
    thread.reply({ id: "msg_2", actorId: ada, text: "on it", inReplyTo: "msg_1", now: 200 });
    const stale = () =>
      thread.reply({
        id: "msg_3",
        actorId: ada,
        text: "me too",
        inReplyTo: "msg_1",
        after: "msg_1",
        now: 300,
      });

    expect(code(stale)).toBe("newer_message");
    expect(thread.snapshot.replyCount).toBe(1);
    thread.reply({
      id: "msg_3",
      actorId: ada,
      text: "ok",
      inReplyTo: "msg_1",
      after: "msg_2",
      now: 300,
    });
    expect(thread.snapshot.replyCount).toBe(2);
  });

  test("a message needs text unless it carries files, and has limits", () => {
    expect(code(() => start("  "))).toBe("invalid_message");
    expect(code(() => start("x".repeat(MAX_TEXT_LENGTH + 1)))).toBe("invalid_message");

    const files = (ids: string[]) => () =>
      Thread.start({
        id: "msg_1",
        vibeId: "vb_1",
        channel,
        actorId: ada,
        text: "",
        attachmentIds: ids,
        now: 1,
      });
    expect(code(files(["att_1"]))).toBeNull();
    expect(code(files(["att_1", "att_1"]))).toBe("invalid_message");
    expect(code(files(Array.from({ length: 11 }, (_, i) => `att_${i}`)))).toBe("invalid_message");
  });

  test("labels hold one value per key, and a change records only what it changed", () => {
    const thread = start();
    thread.pullEvents();
    const label = (change: LabelChange) =>
      thread.label({ messageId: "msg_1", actorId: ada, change, now: 200 });

    expect(label({ set: { state: "open", kind: "bug" } }).labels).toEqual({
      state: "open",
      kind: "bug",
    });
    expect(label({ set: { state: "fixing", kind: "bug" }, unset: ["wip"] })).toEqual({
      labels: { state: "fixing", kind: "bug" },
      set: { state: "fixing" },
      unset: [],
    });
    // Already as asked: nothing happens, so nothing is recorded.
    expect(label({ set: { state: "fixing" } }).set).toEqual({});

    const events = thread.pullEvents();
    expect(events.map((e) => [e.type, e.threadVersion])).toEqual([
      ["labels.changed", 2],
      ["labels.changed", 3],
    ]);
    expect(events[1]?.facets).toEqual({
      labels: { state: ["fixing"], kind: ["bug"] },
      mentions: [],
      was: { labels: { state: ["open"], kind: ["bug"] }, mentions: [] },
    });
  });

  test("a conditional label change lands only while its conditions hold", () => {
    const thread = start();
    const label = (change: LabelChange) => () =>
      thread.label({ messageId: "msg_1", actorId: ada, change, now: 200 });

    expect(code(label({ set: { owner: "fx" }, if: { owner: null } }))).toBeNull();
    expect(code(label({ set: { owner: "codex" }, if: { owner: null } }))).toBe("label_conflict");
    expect(code(label({ set: { state: "done" }, if: { owner: "codex" } }))).toBe("label_conflict");
    expect(code(label({ unset: ["owner"], if: { owner: "fx" } }))).toBeNull();
    expect(thread.snapshot.version).toBe(3);
  });

  test("labels are checked, and the vibe's own can't be set by hand", () => {
    const label = (change: LabelChange) => () =>
      start().label({ messageId: "msg_1", actorId: ada, change, now: 200 });

    expect(code(label({ set: { "vibe.task": "ready" } }))).toBe("reserved_label");
    expect(code(label({ unset: ["vibe.task"] }))).toBe("reserved_label");
    for (const set of [
      { State: "open" },
      { "-x": "1" },
      { state: "" },
      { state: "a\nb" },
      { state: "x".repeat(257) },
    ]) {
      expect(code(label({ set }))).toBe("invalid_label");
    }
    expect(code(label({ set: { a: "1" }, unset: ["a"] }))).toBe("invalid_label");
    expect(
      code(() =>
        Thread.start({
          id: "msg_1",
          vibeId: "vb_1",
          channel,
          actorId: ada,
          text: "x",
          labels: { "vibe.task": "ready" },
          now: 1,
        }),
      ),
    ).toBe("reserved_label");
  });

  test("a message is held to its number of labels from its first post", () => {
    const many = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, n) => [`k${n}`, "v"]));
    const posted = (count: number) => () =>
      Thread.start({
        id: "msg_1",
        vibeId: "vb_1",
        channel,
        actorId: ada,
        text: "labeled",
        labels: many(count),
        now: 100,
      });
    expect(code(posted(64))).toBeNull();
    // One more could never be changed again: every change would find it over.
    expect(code(posted(65))).toBe("invalid_label");
    const thread = posted(64)();
    expect(
      code(() =>
        thread.reply({
          id: "msg_2",
          inReplyTo: "msg_1",
          actorId: ada,
          text: "too many",
          labels: many(65),
          now: 200,
        }),
      ),
    ).toBe("invalid_label");
  });

  test("a label may be named for anything, what every object holds included", () => {
    const thread = start();
    thread.pullEvents();
    const label = (change: LabelChange) => () =>
      thread.label({ messageId: "msg_1", actorId: ada, change, now: 200 });

    // Not there yet, whatever an object has under the name.
    expect(code(label({ set: { tostring: "x" }, if: { constructor: "anything" } }))).toBe(
      "label_conflict",
    );
    expect(code(label({ set: { constructor: "ada" }, if: { constructor: null } }))).toBeNull();
    expect(code(label({ set: { constructor: "bob" }, if: { constructor: null } }))).toBe(
      "label_conflict",
    );
    expect(code(label({ set: { valueof: "1", hasownproperty: "2" } }))).toBeNull();
    const [first] = thread.pullEvents();
    expect(first?.facets).toMatchObject({ labels: { constructor: ["ada"] } });
    // A reply is matched on its root's labels, that one among them.
    thread.reply({ id: "msg_2", inReplyTo: "msg_1", actorId: ada, text: "under it", now: 300 });
    expect(thread.pullEvents().at(-1)?.facets).toMatchObject({
      labels: { constructor: ["ada"] },
    });
    expect(code(label({ unset: ["constructor"], if: { constructor: "ada" } }))).toBeNull();
    expect(code(label({ unset: ["constructor"] }))).toBeNull();
  });

  test("a reply is matched on its own labels and on its root's", () => {
    const thread = Thread.start({
      id: "msg_1",
      vibeId: "vb_1",
      channel,
      actorId: ada,
      text: "bug",
      labels: { state: "open" },
      now: 1,
    });
    thread.reply({
      id: "msg_2",
      actorId: ada,
      text: "dup",
      inReplyTo: "msg_1",
      labels: { state: "noted", kind: "note" },
      now: 2,
    });
    const [, reply] = thread.pullEvents();
    expect(reply?.facets).toEqual({
      labels: { state: ["noted", "open"], kind: ["note"] },
      mentions: [],
    });
    expect(code(() => thread.label({ messageId: "msg_9", actorId: ada, change: {}, now: 3 }))).toBe(
      "message_not_found",
    );
  });

  const person = (id: string) => ({ actorId: id, principal: id, profile: null });
  const profile = (principal: string, name: string) => ({
    actorId: `${principal}+${name}`,
    principal,
    profile: name,
  });

  test("an edit replaces the text and changes the revision", () => {
    const thread = start("deploys are gren");
    const edit = (text: string, revision?: number) => () =>
      thread.edit({ messageId: "msg_1", by: person(ada), text, revision, now: 200 });

    expect(edit("deploys are green", 1)()).toBe(true);
    expect(code(edit("again", 1))).toBe("revision_conflict");
    expect(edit("deploys are green")()).toBe(false);
    expect(code(edit("  "))).toBe("invalid_message");
    expect(thread.pullEvents().at(-1)).toMatchObject({
      type: "message.edited",
      text: "deploys are green",
      revision: 2,
      threadVersion: 2,
    });
  });

  test("only the author edits or deletes, and a profile only what it wrote", () => {
    const fx = profile(ada, "fx");
    const codex = profile(ada, "codex");
    const thread = Thread.start({
      id: "msg_1",
      vibeId: "vb_1",
      channel,
      actorId: fx.actorId,
      text: "from fx",
      now: 1,
    });
    const edit = (by: Editor) => () =>
      thread.edit({ messageId: "msg_1", by, text: `${by.actorId} was here`, now: 2 });

    expect(code(edit(person("vibe:user:u_bob")))).toBe("forbidden");
    expect(code(edit(codex))).toBe("forbidden");
    expect(code(edit(fx))).toBeNull();
    // A person writing as themselves can fix what their agents wrote.
    expect(code(edit(person(ada)))).toBeNull();

    const bob = person("vibe:user:u_bob");
    expect(code(() => thread.delete({ messageId: "msg_1", by: bob, now: 3 }))).toBe("forbidden");
    expect(thread.delete({ messageId: "msg_1", by: bob, moderator: true, now: 3 })).toBe(true);
  });

  test("a deleted message is a tombstone: emptied, unlabeled, and closed to changes", () => {
    const thread = Thread.start({
      id: "msg_1",
      vibeId: "vb_1",
      channel,
      actorId: ada,
      text: "oops",
      labels: { state: "open" },
      now: 1,
    });
    thread.react({ messageId: "msg_1", actorId: ada, emoji: "eyes", now: 2 });
    thread.pullEvents();
    const remove = (revision?: number) => () =>
      thread.delete({ messageId: "msg_1", by: person(ada), revision, now: 3 });

    expect(code(remove(7))).toBe("revision_conflict");
    expect(remove(1)()).toBe(true);
    expect(thread.pullEvents()).toMatchObject([
      {
        type: "message.deleted",
        revision: 2,
        // It matched state=open before, so whoever follows that label sees it go.
        facets: { labels: {}, was: { labels: { state: ["open"] } } },
      },
    ]);
    // Deleting again does nothing, whatever revision is named.
    expect(remove(1)()).toBe(false);
    // For someone who couldn't have deleted it, it is refused like any delete.
    const stranger = person("vibe:user:u_bob");
    expect(code(() => thread.delete({ messageId: "msg_1", by: stranger, now: 4 }))).toBe(
      "forbidden",
    );

    const by = person(ada);
    const changes = [
      () => thread.edit({ messageId: "msg_1", by, text: "back", now: 4 }),
      () => thread.label({ messageId: "msg_1", actorId: ada, change: { set: { a: "b" } }, now: 4 }),
      () => thread.react({ messageId: "msg_1", actorId: ada, emoji: "eyes", now: 4 }),
    ];
    expect(changes.map(code)).toEqual(["message_deleted", "message_deleted", "message_deleted"]);
    // Its replies stay, and new ones can still join.
    expect(
      code(() =>
        thread.reply({ id: "msg_2", actorId: ada, text: "why?", inReplyTo: "msg_1", now: 5 }),
      ),
    ).toBeNull();
  });

  test("each actor reacts with an emoji once, under one normalized name", () => {
    const thread = start();
    thread.pullEvents();
    const react = (actorId: string, emoji: string, remove = false) =>
      thread.react({ messageId: "msg_1", actorId, emoji, remove, now: 2 });

    expect(react(ada, "👍")).toBe(true);
    expect(react(ada, ":+1:")).toBe(false);
    expect(react(ada, "thumbs_up")).toBe(false);
    expect(react("vibe:user:u_bob", "+1")).toBe(true);
    expect(react(ada, "eyes", true)).toBe(false);
    expect(react(ada, "THUMBS_UP", true)).toBe(true);
    expect(thread.pullEvents().map((e) => [e.type, "emoji" in e && e.emoji, e.actorId])).toEqual([
      ["reaction.added", "thumbs_up", ada],
      ["reaction.added", "thumbs_up", "vibe:user:u_bob"],
      ["reaction.removed", "thumbs_up", ada],
    ]);
    expect(code(() => react(ada, "not an emoji"))).toBe("invalid_emoji");
    expect(normalizeEmoji("❤️")).toBe("heart");
    expect(normalizeEmoji("🦀")).toBe("🦀");
    // A name that every object answers to is a name like any other.
    expect(normalizeEmoji("constructor")).toBe("constructor");
    expect(normalizeEmoji(":toString:")).toBe("tostring");
  });

  test("an edit that changes who is mentioned still reaches who was", () => {
    const thread = Thread.start({
      id: "msg_1",
      vibeId: "vb_1",
      channel,
      actorId: ada,
      text: "@[vibe:user:u_bob] ready?",
      mentions: ["vibe:user:u_bob"],
      now: 1,
    });
    const [posted] = thread.pullEvents();
    expect(posted?.facets).toEqual({ labels: {}, mentions: ["vibe:user:u_bob"] });

    thread.edit({ messageId: "msg_1", by: person(ada), text: "never mind", now: 2 });
    expect(thread.pullEvents()[0]?.facets).toEqual({
      labels: {},
      mentions: [],
      was: { labels: {}, mentions: ["vibe:user:u_bob"] },
    });
  });
});

describe("mentions", () => {
  const visible = [
    { id: "vibe:user:u_ada", handle: "ada" },
    { id: "vibe:user:u_ada+fx", handle: "ada/fx" },
    { id: "vibe:user:u_bob", handle: "bob" },
  ];
  const settle = (text: string) => settleMentions(text, visible);

  test("a handle that a visible actor has becomes a mention of that actor", () => {
    expect(settle("@ada ready to promote? cc @Bob, @ada/fx.")).toEqual({
      text: "@[vibe:user:u_ada] ready to promote? cc @[vibe:user:u_bob], @[vibe:user:u_ada+fx].",
      mentions: ["vibe:user:u_ada", "vibe:user:u_bob", "vibe:user:u_ada+fx"],
      unresolved: [],
    });
    // Mentioning someone twice mentions them once.
    expect(settle("@ada @ada").mentions).toEqual(["vibe:user:u_ada"]);
  });

  test("a handle no one has stays plain text, and never fails the write", () => {
    expect(settle("thanks @nobody and @bob/ghost, and @bob")).toEqual({
      text: "thanks @nobody and @bob/ghost, and @[vibe:user:u_bob]",
      mentions: ["vibe:user:u_bob"],
      unresolved: ["@nobody", "@bob/ghost"],
    });
  });

  test("the exact form names an actor by ID, and survives being settled again", () => {
    const once = settle("over to @ada/fx");
    expect(settle(once.text)).toEqual({ ...once, unresolved: [] });
    expect(settle("@[vibe:user:u_zed] hi")).toEqual({
      text: "@[vibe:user:u_zed] hi",
      mentions: [],
      unresolved: ["@[vibe:user:u_zed]"],
    });
  });

  test("code, email addresses and paths are not mentions", () => {
    for (const text of [
      "run `@ada` to see",
      "```\n@ada\n```",
      "~~~sh\necho @bob\n~~~\n",
      "mail ada@bob.dev",
      "see packages/@ada/core",
      "@ada_b is not a handle",
    ]) {
      expect([text, settle(text).mentions]).toEqual([text, []]);
    }
    expect(settle("`code` then @ada\n```\n@bob\n```\nand @bob").mentions).toEqual([
      "vibe:user:u_ada",
      "vibe:user:u_bob",
    ]);
  });

  test("a settled mention counts as one character of the text", () => {
    expect(writtenLength("@[vibe:user:u_01jd0000000000000000000000] hi")).toBe(4);
    const text = `${"x".repeat(MAX_TEXT_LENGTH - 1)}@[vibe:user:u_bob]`;
    expect(code(() => start(text))).toBeNull();
    expect(code(() => start(`${text}!`))).toBe("invalid_message");
  });
});

describe("changes another context records", () => {
  test("take the thread's next version and set the vibe's own labels on the root", () => {
    const thread = start();
    thread.pullEvents();
    thread.note({
      as: "task.created",
      actorId: ada,
      payload: { state: "ready" },
      labels: { "vibe.task": "ready" },
      now: 200,
    });
    thread.note({ as: "task.claimed", actorId: ada, labels: { "vibe.task": "claimed" }, now: 300 });

    const [created, claimed] = thread.pullEvents();
    expect(created).toMatchObject({
      type: "thread.noted",
      as: "task.created",
      threadVersion: 2,
      messageId: "msg_1",
      payload: { state: "ready" },
      set: { "vibe.task": "ready" },
      facets: { labels: { "vibe.task": ["ready"] }, was: { labels: {} } },
    });
    // A follower of `vibe.task=ready` sees the task leave that view too.
    expect(claimed).toMatchObject({
      threadVersion: 3,
      set: { "vibe.task": "claimed" },
      facets: { labels: { "vibe.task": ["claimed"] }, was: { labels: { "vibe.task": ["ready"] } } },
    });
  });

  test("a label that is already as noted is not set again, and null removes one", () => {
    const thread = start();
    thread.note({ as: "task.created", actorId: ada, labels: { "vibe.task": "ready" }, now: 200 });
    thread.pullEvents();
    thread.note({ as: "task.renewed", actorId: ada, labels: { "vibe.task": "ready" }, now: 300 });
    thread.note({ as: "task.dropped", actorId: ada, labels: { "vibe.task": null }, now: 400 });

    const [renewed, dropped] = thread.pullEvents();
    expect(renewed).toMatchObject({ set: {}, unset: [] });
    expect(dropped).toMatchObject({ set: {}, unset: ["vibe.task"] });
  });

  test("are for the vibe's own labels only, which stay off limits by hand", () => {
    const thread = start();
    expect(() =>
      thread.note({ as: "x.y", actorId: ada, labels: { state: "open" }, now: 200 }),
    ).toThrow(TypeError);
    const byHand = () =>
      thread.label({
        messageId: "msg_1",
        actorId: ada,
        change: { set: { "vibe.task": "done" } },
        now: 200,
      });
    expect(code(byHand)).toBe("reserved_label");
  });

  test("leave a deleted root's labels alone", () => {
    const thread = start();
    thread.delete({
      messageId: "msg_1",
      by: { actorId: ada, principal: ada, profile: null },
      now: 200,
    });
    thread.pullEvents();
    thread.note({
      as: "task.canceled",
      actorId: ada,
      labels: { "vibe.task": "canceled" },
      now: 300,
    });
    expect(thread.pullEvents()[0]).toMatchObject({ as: "task.canceled", set: {}, unset: [] });
  });
});

describe("structured data", () => {
  const me: Editor = { actorId: ada, principal: ada, profile: null };
  const sandbox = (action: string) => ({ schema: "sandbox", version: 1, data: { action } });

  test("data alone makes a message, and travels with the post", () => {
    const thread = Thread.start({
      id: "msg_1",
      vibeId: "vb_1",
      channel,
      actorId: ada,
      text: "",
      blocks: [sandbox("started")],
      now: 100,
    });
    expect(thread.pullEvents()[0]).toMatchObject({
      type: "message.posted",
      message: { text: "", blocks: [sandbox("started")] },
    });
  });

  test("an edit changes the text, the data, or both, and keeps what it doesn't name", () => {
    const thread = start("sandbox sbx-1");
    thread.pullEvents();

    expect(
      thread.edit({ messageId: "msg_1", by: me, blocks: [sandbox("started")], now: 200 }),
    ).toBe(true);
    expect(thread.pullEvents()[0]).toMatchObject({
      type: "message.edited",
      text: "sandbox sbx-1",
      blocks: [sandbox("started")],
      revision: 2,
    });

    expect(thread.edit({ messageId: "msg_1", by: me, text: "done", now: 300 })).toBe(true);
    expect(thread.pullEvents()[0]).toMatchObject({ text: "done", blocks: [sandbox("started")] });

    // What it already holds, whatever order the keys come in, is no change.
    const same = [{ version: 1, data: { action: "started" }, schema: "sandbox" }];
    expect(thread.edit({ messageId: "msg_1", by: me, text: "done", blocks: same, now: 400 })).toBe(
      false,
    );
    expect(thread.pullEvents()).toEqual([]);
  });

  test("an edit keeps the mentions when it leaves the text alone", () => {
    const bob = "vibe:user:u_bob";
    const thread = Thread.start({
      id: "msg_1",
      vibeId: "vb_1",
      channel,
      actorId: ada,
      text: `@[${bob}] look`,
      mentions: [bob],
      now: 100,
    });
    thread.pullEvents();
    thread.edit({ messageId: "msg_1", by: me, blocks: [sandbox("started")], now: 200 });
    expect(thread.pullEvents()[0]).toMatchObject({ mentions: [bob] });
  });

  test("a message can't be edited down to nothing, and holds only so much data", () => {
    const thread = Thread.start({
      id: "msg_1",
      vibeId: "vb_1",
      channel,
      actorId: ada,
      text: "",
      blocks: [sandbox("started")],
      now: 100,
    });
    expect(code(() => thread.edit({ messageId: "msg_1", by: me, blocks: [], now: 200 }))).toBe(
      "invalid_message",
    );
    const many = Array.from({ length: 9 }, () => sandbox("started"));
    expect(code(() => thread.edit({ messageId: "msg_1", by: me, blocks: many, now: 200 }))).toBe(
      "invalid_message",
    );
    const heavy = [{ schema: "blob", version: 1, data: { bytes: "x".repeat(70_000) } }];
    expect(code(() => thread.edit({ messageId: "msg_1", by: me, blocks: heavy, now: 200 }))).toBe(
      "invalid_message",
    );
  });
});
