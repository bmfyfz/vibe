import { afterAll, describe, expect, test } from "bun:test";

import { type Permission, vibe as connect } from "@vibe/sdk";

import { harness } from "./harness.ts";
import { deliver, eventually, failing, settle, syncEntries } from "./sync-helpers.ts";

const vibe = harness();
const { slack } = vibe.platforms;
const WITHOUT_SYNC: Permission[] = ["read", "post", "react", "label"];
// A test that waits out a retry waits for real against a running Vibe.
const SLOW = 30_000;

describe.skipIf(!vibe.near)("sync with Slack", () => {
  const entries = syncEntries(vibe);
  afterAll(() => entries.removeAll());

  /** A Slack channel mapped to a vibe channel, both new. */
  async function mapped() {
    const name = vibe.name("errors");
    const channel = vibe.channel("synced");
    const slackChannel = slack.channel(name);
    const syncing = await entries.add("slack", { [`#${name}`]: channel });
    return { ...syncing, channel, slackChannel, name };
  }

  test("a Slack thread comes in as the person who wrote it, shown through the service", async () => {
    const { owner, source, key, service, channel, slackChannel } = await mapped();
    const malte = slack.user("Malte Ubl");

    const first = slack.said({ channel: slackChannel, user: malte, text: "checkout is *down*" });
    await deliver(vibe, source, slack.signed(first));

    const { threads } = await owner.threads({ channel });
    expect(threads).toHaveLength(1);
    const root = threads[0]?.message;
    expect(root).toMatchObject({
      channel,
      text: "checkout is **down**",
      from: key,
      by: { name: "Malte Ubl", handle: `${service}/u-malte-ubl` },
    });
    // A platform user is a profile of the service that syncs them.
    expect(root?.by.actor).toBe(`${root?.by.principal}+${key}:user:${malte}`);
    expect(root?.by.principal).toStartWith("vibe:service:");

    const reply = slack.said({
      channel: slackChannel,
      user: malte,
      text: "rolled back",
      thread_ts: String(first.event["ts"]),
    });
    await deliver(vibe, source, slack.signed(reply));
    const thread = await owner.thread(root?.id ?? "");
    expect(thread.replies.map((each) => each.text)).toEqual(["rolled back"]);
    expect(thread.sync?.targets).toMatchObject([
      { source: key, platform: "slack", state: "synced" },
    ]);

    // Nothing that came from Slack is sent back to where it came from.
    await settle(vibe);
    expect(slack.posted(slackChannel)).toEqual([]);
  });

  test("a new thread in a mapped channel starts a Slack thread, and replies follow it", async () => {
    const { owner, key, channel, slackChannel } = await mapped();
    const { client: ada, handle } = await vibe.join();

    const root = await ada.post(channel, "deploys are **green** again", {
      labels: { state: "open" },
    });
    const [started] = await eventually(vibe, () => {
      expect(slack.posted(slackChannel)).toHaveLength(1);
      return slack.posted(slackChannel);
    });
    expect(started).toMatchObject({
      thread: null,
      text: `**${handle}:** deploys are **green** again`,
    });
    // Labels never leave the vibe.
    expect(JSON.stringify(slack.posted(slackChannel))).not.toContain("state");

    await ada.reply(root.id, "and stay that way");
    const posted = await eventually(vibe, () => {
      expect(slack.posted(slackChannel)).toHaveLength(2);
      return slack.posted(slackChannel);
    });
    expect(posted[1]).toMatchObject({
      thread: started?.ts,
      text: `**${handle}:** and stay that way`,
    });

    const synced = await owner.sync(root.id);
    expect(synced.targets).toMatchObject([
      { source: key, target: `${key}:${slackChannel}:${started?.ts}`, state: "synced" },
    ]);
    expect(synced.targets[0]?.copy).toContain(slackChannel);
  });

  test("an entry is an owner's to make, for a service, and never shows what it was given", async () => {
    const { owner, source, key, service, channel, name } = await mapped();
    const { client: member } = await vibe.join();

    expect(source).toMatchObject({
      key,
      platform: "slack",
      service: { handle: service },
      mappings: [{ platform: `#${name}`, channel, only: null, out: true }],
      state: "active",
      webhook: `/v1/sync/webhooks/${source.id}`,
    });
    // Anyone who reads here can check where their words may go. No one is shown the credentials.
    const listed = await member.sources();
    expect(listed.find((each) => each.key === key)?.id).toBe(source.id);
    expect(JSON.stringify(listed)).not.toContain(slack.token);
    expect(JSON.stringify(listed)).not.toContain(slack.signingSecret);

    const again = {
      key,
      platform: "slack" as const,
      service,
      credentials: { token: slack.token, secret: "s" },
    };
    const api = vibe.platformApi("slack");
    expect(await failing(member.createSource({ ...again, key: vibe.name("mine"), api }))).toBe(
      "forbidden",
    );
    expect(await failing(owner.createSource({ ...again, api }))).toBe("source_exists");
    expect(await failing(owner.createSource({ ...again, key: "vibe", api }))).toBe(
      "invalid_source",
    );
    expect(
      await failing(
        owner.createSource({ ...again, key: vibe.name("s"), service: "no-such-service", api }),
      ),
    ).toBe("invalid_source");
    // Slack is asked who the token is, so one that isn't Slack's is refused here.
    expect(
      await failing(
        owner.createSource({
          ...again,
          key: vibe.name("s"),
          credentials: { token: "xoxb-wrong", secret: "s" },
          api,
        }),
      ),
    ).toBe("invalid_source");
    expect(
      await failing(
        owner.createSource({
          ...again,
          key: vibe.name("s"),
          map: { "#no-such-channel": channel },
          api,
        }),
      ),
    ).toBe("invalid_source");
    // The API is https, or this machine: a token is not sent anywhere else in the clear.
    expect(
      await failing(
        owner.createSource({ ...again, key: vibe.name("s"), api: "http://example.com/api" }),
      ),
    ).toBe("invalid_source");

    // A caller under a limit sets up nothing, and is shown none of sync's records.
    const narrowed = owner.as("agent", { can: { "*": "all" } });
    expect(await failing(narrowed.sources())).toBe("forbidden");
    expect(await failing(narrowed.createSource({ ...again, key: vibe.name("s"), api }))).toBe(
      "forbidden",
    );
    expect(await failing(member.deleteSource(key))).toBe("forbidden");
  });

  test("Slack's check of the URL is answered, once it is known to be Slack's", async () => {
    const { source } = await mapped();
    const question = {
      type: "url_verification",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
      token: "x",
    };
    const answer = await vibe.webhook(source, slack.signed(question));
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe(question.challenge);
    expect((await vibe.webhook(source, slack.signed(question, { secret: "guess" }))).status).toBe(
      401,
    );
  });

  test("a message comes in once, however often Slack sends it", async () => {
    const { owner, source, channel, slackChannel } = await mapped();
    const event = slack.said({ channel: slackChannel, user: slack.user("Grace"), text: "once" });

    // The same delivery again, as after a timeout, and the same message under another delivery.
    await deliver(vibe, source, slack.signed(event));
    await deliver(vibe, source, slack.signed(event));
    await deliver(vibe, source, slack.signed({ ...event, event_id: "Ev0SECONDTIME" }));
    // Both at once: one commit lands, and the other finds the message recorded.
    const racing = slack.said({ channel: slackChannel, user: slack.user("Grace"), text: "twice?" });
    await Promise.all([
      deliver(vibe, source, slack.signed(racing)),
      deliver(vibe, source, slack.signed({ ...racing, event_id: "Ev0RACING" })),
    ]);

    const { threads } = await owner.threads({ channel });
    expect(threads.map((thread) => thread.message.text).sort()).toEqual(["once", "twice?"]);
  });

  test("what Slack's people say is told apart from what is written here, by where it came from", async () => {
    const { owner, source, key, service, channel, slackChannel } = await mapped();
    const { client: ada } = await vibe.join();
    const grace = slack.user("Grace Hopper");
    await deliver(
      vibe,
      source,
      slack.signed(slack.said({ channel: slackChannel, user: grace, text: "from slack" })),
    );
    await ada.post(channel, "from the vibe");

    const from = async (named: string) =>
      (await owner.threads({ channel, source: named })).threads.map(
        (thread) => thread.message.text,
      );
    expect(await from(key)).toEqual(["from slack"]);
    expect(await from("vibe")).toEqual(["from the vibe"]);
    // The service's handle covers the platform users it brought in.
    expect((await owner.threads({ channel, by: service })).threads).toHaveLength(1);
    const actors = await owner.actors();
    expect(actors.find((actor) => actor.handle === `${service}/u-grace-hopper`)).toMatchObject({
      name: "Grace Hopper",
      profile: `${key}:user:${grace}`,
    });
    // No request can write as a platform user: the name is not one a request can give.
    const { token } = await owner.createService({ name: vibe.name("svc") });
    const impostor = vibe.connect(token).as(`${key}:user:${grace}`);
    expect(await failing(impostor.post(channel, "it's me, Grace"))).toBe("invalid_profile");
  });

  test("a mention crosses over as a mention, on both sides", async () => {
    const { owner, source, service, channel, slackChannel } = await mapped();
    const { client: ada, handle } = await vibe.join();
    const malte = slack.user("Malte");
    const lee = slack.user("Lee");

    // Lee has not written yet. Slack is asked who they are, and they are mentioned by name.
    const text = `<@${lee}> and @${handle}: can you look?`;
    await deliver(
      vibe,
      source,
      slack.signed(slack.said({ channel: slackChannel, user: malte, text })),
    );
    const root = (await owner.threads({ channel })).threads[0]?.message;
    expect(root?.mentions.map((mention) => mention.handle).sort()).toEqual(
      [handle, `${service}/u-lee`].sort(),
    );

    // Back out, Malte is mentioned the way Slack mentions, and ada by name, in plain text.
    await ada.reply(root?.id ?? "", `@${service}/u-malte yes. @${handle} too`);
    const [sent] = await eventually(vibe, () => {
      expect(slack.posted(slackChannel)).toHaveLength(1);
      return slack.posted(slackChannel);
    });
    expect(sent?.text).toBe(`**${handle}:** <@${malte}> yes. ${handle} too`);
  });

  test("with the scope for it, a message goes out under its author's name", async () => {
    slack.scopes.push("chat:write.customize");
    try {
      const { channel, slackChannel } = await mapped();
      const { client: ada, handle } = await vibe.join();
      await ada.as("fx").post(channel, "tests pass");
      const [sent] = await eventually(vibe, () => {
        expect(slack.posted(slackChannel)).toHaveLength(1);
        return slack.posted(slackChannel);
      });
      expect(sent).toMatchObject({ username: `fx via ${handle}`, text: "tests pass" });
    } finally {
      slack.scopes.pop();
    }
  });

  test("noSync keeps a message, or with its root a whole thread, off Slack", async () => {
    const { owner, key, channel, slackChannel } = await mapped();
    const { client: ada } = await vibe.join();

    const kept = await ada.post(channel, "postmortem draft, internal only", { noSync: true });
    expect(kept.noSync).toBe(true);
    await ada.reply(kept.id, "still internal");
    const open = await ada.post(channel, "public summary");
    await ada.reply(open.id, "notes for the team only", { noSync: true });
    await ada.reply(open.id, "follow-up for everyone");

    const posted = await eventually(vibe, () => {
      expect(slack.posted(slackChannel)).toHaveLength(2);
      return slack.posted(slackChannel);
    });
    await settle(vibe);
    expect(
      slack.posted(slackChannel).map((message) => message.text.replace(/^\*\*.*?\*\* /, "")),
    ).toEqual(["public summary", "follow-up for everyone"]);
    expect(posted[1]?.thread).toBe(posted[0]?.ts);

    // Kept off for good: no one syncs the thread later, and a post can't ask for both.
    expect(await failing(owner.sync(kept.id, `${key}:${slackChannel}`))).toBe("no_sync");
    expect(
      await failing(ada.post(channel, "both?", { noSync: true, sync: `${key}:${slackChannel}` })),
    ).toBe("invalid_request");
    expect((await owner.sync(kept.id)).targets).toEqual([]);
  });

  test("edits, deletes and reactions follow, in both directions", async () => {
    const { owner, source, channel, slackChannel } = await mapped();
    const { client: ada, handle } = await vibe.join();
    const malte = slack.user("Malte");

    // From the vibe to Slack.
    const root = await ada.post(channel, "v1 of the plan");
    const [copy] = await eventually(vibe, () => {
      expect(slack.posted(slackChannel)).toHaveLength(1);
      return slack.posted(slackChannel);
    });
    await ada.edit(root.id, "v2 of the plan");
    await owner.react(root.id, "👍");
    await eventually(vibe, () => {
      expect(slack.posted(slackChannel)[0]?.text).toBe(`**${handle}:** v2 of the plan`);
      expect(slack.reactions).toContainEqual({
        channel: slackChannel,
        ts: copy?.ts ?? "",
        name: "thumbsup",
      });
    });
    // The entry reacts once for everyone, and its reaction stays while anyone's does.
    await ada.react(root.id, "thumbs_up");
    await owner.react(root.id, "thumbs_up", { remove: true });
    await settle(vibe);
    expect(slack.reactions).toHaveLength(1);
    await ada.react(root.id, "thumbs_up", { remove: true });
    await eventually(vibe, () => expect(slack.reactions).toEqual([]));

    // From Slack to the vibe.
    const ts = slack.ts();
    const said = {
      channel: slackChannel,
      user: malte,
      text: "lgtm",
      ts,
      thread_ts: copy?.ts ?? "",
    };
    await deliver(vibe, source, slack.signed(slack.said(said)));
    const reply = (await owner.thread(root.id)).replies[0];
    expect(reply).toMatchObject({ text: "lgtm", by: { name: "Malte" } });

    const changed = {
      type: "message",
      subtype: "message_changed",
      channel: slackChannel,
      ts: slack.ts(),
    };
    const message = {
      type: "message",
      user: malte,
      text: "lgtm, _mostly_",
      ts,
      thread_ts: copy?.ts,
    };
    await deliver(vibe, source, slack.signed(slack.event({ ...changed, message })));
    const item = { type: "message", channel: slackChannel, ts };
    await deliver(
      vibe,
      source,
      slack.signed(slack.event({ type: "reaction_added", user: malte, reaction: "eyes", item })),
    );
    const edited = (await owner.thread(root.id)).replies[0];
    expect(edited).toMatchObject({ text: "lgtm, _mostly_", revision: 2 });
    // What Slack's people did is not done to Slack again in the entry's name.
    await settle(vibe);
    expect(slack.reactions).toEqual([]);
    expect(
      vibe.platforms.calls.filter((call) => call.what === "chat.update" && call.args["ts"] === ts),
    ).toEqual([]);
    expect(edited?.reactions).toMatchObject([
      { emoji: "eyes", by: [{ handle: reply?.by.handle }] },
    ]);

    await deliver(
      vibe,
      source,
      slack.signed(slack.event({ type: "reaction_removed", user: malte, reaction: "eyes", item })),
    );
    const gone = {
      type: "message",
      subtype: "message_deleted",
      channel: slackChannel,
      ts: slack.ts(),
      deleted_ts: ts,
    };
    await deliver(vibe, source, slack.signed(slack.event(gone)));
    const tombstone = (await owner.thread(root.id)).replies[0];
    expect(tombstone?.deletedAt).not.toBeNull();
    expect(tombstone?.reactions).toEqual([]);

    // A delete here removes the copy there.
    await ada.delete(root.id);
    await eventually(vibe, () => expect(slack.posted(slackChannel)).toEqual([]));
  });

  test(
    "a delivery that fails is tried again, and holds nothing else up meanwhile",
    async () => {
      const { owner, key, channel, slackChannel } = await mapped();
      const { client: ada } = await vibe.join();

      vibe.platforms.fail(1, { matching: "chat.postMessage" });
      const first = await ada.post(channel, "sent on the second try");
      await eventually(vibe, () =>
        expect(
          vibe.platforms.calls.filter((call) => !call.ok && call.args["channel"] === slackChannel),
        ).toHaveLength(1),
      );
      expect((await owner.sources()).find((each) => each.key === key)).toMatchObject({
        pending: 1,
        failed: 0,
      });
      expect((await owner.sync(first.id)).targets).toMatchObject([{ state: "starting" }]);

      // The next message doesn't wait for the one that failed.
      await ada.post(channel, "sent at once");
      await eventually(vibe, () =>
        expect(slack.posted(slackChannel).map((message) => message.text)).toContainEqual(
          expect.stringContaining("sent at once"),
        ),
      );

      // The retry comes two seconds after the failure, and not before.
      if (vibe.canJump) {
        await settle(vibe);
        expect(slack.posted(slackChannel)).toHaveLength(1);
      }
      await vibe.pass(2500);
      await eventually(vibe, () => expect(slack.posted(slackChannel)).toHaveLength(2));
      expect((await owner.sync(first.id)).targets).toMatchObject([{ state: "synced" }]);
      expect((await owner.sources()).find((each) => each.key === key)).toMatchObject({
        pending: 0,
        failed: 0,
      });
      // The receipts are in the log, for whoever asks for the bookkeeping too.
      const { events } = await owner.poll({ re: first.id, after: first.id, all: true });
      expect(events.map((event) => event.type)).toEqual(["thread.synced", "message.synced"]);
      expect(events[1]).toMatchObject({ message: { id: first.id }, payload: { source: key } });
      expect(
        (await owner.poll({ re: first.id, after: first.id })).events.map((event) => event.type),
      ).toEqual(["thread.synced"]);
    },
    SLOW,
  );

  test(
    "a copy that waited for a retry is not sent once its service may no longer read the channel",
    async () => {
      const { owner, key, service, channel, slackChannel } = await mapped();
      const { client: ada } = await vibe.join();

      vibe.platforms.fail(1, { matching: "chat.postMessage" });
      await ada.post(channel, "written before the channel was closed to the service");
      await eventually(vibe, () =>
        expect(
          vibe.platforms.calls.filter((call) => !call.ok && call.args["channel"] === slackChannel),
        ).toHaveLength(1),
      );

      // The service keeps `sync` and `post` there, and loses `read`.
      const narrowed = await owner.createGrant({
        principals: [{ kind: "service", name: service }],
        can: { [channel]: ["post", "sync"] },
      });
      try {
        await vibe.pass(2500);
        await settle(vibe);
        // What it may no longer read, it no longer sends: the retry never goes out.
        expect(slack.posted(slackChannel)).toEqual([]);
        expect((await owner.sources()).find((each) => each.key === key)).toMatchObject({
          pending: 0,
        });
      } finally {
        await owner.revokeGrant(narrowed.id);
      }
    },
    SLOW,
  );

  test.skipIf(!vibe.canJump)(
    "after five retries a delivery is recorded as failed, and the thread goes on",
    async () => {
      const { owner, key, channel, slackChannel } = await mapped();
      const { client: ada } = await vibe.join();
      const root = await ada.post(channel, "the thread starts fine");
      await eventually(vibe, () => expect(slack.posted(slackChannel)).toHaveLength(1));

      vibe.platforms.fail(100, { matching: "chat.postMessage" });
      const lost = await ada.reply(root.id, "this one never arrives");
      const attempts = () =>
        vibe.platforms.calls.filter(
          (call) =>
            !call.ok && call.args["channel"] === slackChannel && call.what === "chat.postMessage",
        ).length;
      // The first attempt and five retries, each after a longer wait.
      for (const wait of [2_000, 10_000, 30_000, 120_000, 600_000]) {
        await vibe.tick();
        await vibe.pass(wait + 1000);
      }
      expect(attempts()).toBe(5);
      expect((await owner.sources()).find((each) => each.key === key)).toMatchObject({
        pending: 1,
        failed: 0,
      });
      await vibe.tick();
      expect(attempts()).toBe(6);
      // Given up on: no seventh attempt, however long it waits.
      await vibe.pass(3_600_000);
      await vibe.tick();
      expect(attempts()).toBe(6);

      const { events } = await owner.poll({ re: root.id, after: lost.id });
      expect(events.map((event) => event.type)).toEqual(["message.sync_failed"]);
      expect(events[0]).toMatchObject({
        message: { id: lost.id },
        payload: { source: key, attempts: 6, error: expect.stringContaining("Slack refused") },
      });
      const failed = (await owner.thread(root.id)).sync?.failures;
      expect(failed).toMatchObject([{ message: lost.id, source: key }]);
      expect((await owner.sources()).find((each) => each.key === key)).toMatchObject({
        pending: 0,
        failed: 1,
      });

      // The messages after it go out, and the failure is shown until one of them has.
      vibe.platforms.recover();
      await ada.reply(root.id, "this one does");
      await eventually(vibe, () => expect(slack.posted(slackChannel)).toHaveLength(2));
      expect((await owner.thread(root.id)).sync?.failures).toEqual([]);
    },
  );

  test(
    "a platform that says when to come back is left alone until then",
    async () => {
      const { channel, slackChannel } = await mapped();
      const { client: ada } = await vibe.join();
      // Slack asks for four seconds, which is longer than the first wait.
      vibe.platforms.fail(1, { matching: "chat.postMessage", status: 429, retryAfter: 4 });
      await ada.post(channel, "rate limited");
      await eventually(vibe, () =>
        expect(
          vibe.platforms.calls.filter(
            (call) => call.status === 429 && call.args["channel"] === slackChannel,
          ),
        ).toHaveLength(1),
      );
      await vibe.pass(2500);
      await settle(vibe);
      expect(slack.posted(slackChannel)).toEqual([]);
      await vibe.pass(2000);
      await eventually(vibe, () => expect(slack.posted(slackChannel)).toHaveLength(1));
    },
    SLOW,
  );

  test("a thread is synced with a channel, which gets it whole, or with a thread, which gets what follows", async () => {
    const { owner, key } = await mapped();
    const { client: ada, handle } = await vibe.join();
    const incidents = slack.channel(vibe.name("incidents"));
    const channel = vibe.channel("unmapped");

    const root = await ada.post(channel, "checkout is down");
    await ada.reply(root.id, "rolling back");
    await ada.reply(root.id, "internal only", { noSync: true });
    await settle(vibe);
    expect(slack.posted(incidents)).toEqual([]);

    // A channel: the thread starts there, and what it holds follows its root, in order.
    expect(await owner.sync(root.id, `${key}:${incidents}`)).toEqual({
      target: `${key}:${incidents}`,
      attached: true,
    });
    const sent = await eventually(vibe, () => {
      expect(slack.posted(incidents)).toHaveLength(2);
      return slack.posted(incidents);
    });
    expect(sent.map((message) => message.text)).toEqual([
      `**${handle}:** checkout is down`,
      `**${handle}:** rolling back`,
    ]);
    expect(sent[1]?.thread).toBe(sent[0]?.ts);
    expect(await owner.sync(root.id, `${key}:${incidents}`)).toMatchObject({ attached: false });

    // A thread that exists: it is joined, and receives what is written after.
    const other = await ada.post(channel, "a second thread");
    await ada.reply(other.id, "written before the join");
    const existing = `${incidents}:${slack.ts()}`;
    expect(await owner.sync(other.id, `${key}:${existing}`)).toEqual({
      target: `${key}:${existing}`,
      attached: true,
    });
    await ada.reply(other.id, "written after the join");
    await eventually(vibe, () => expect(slack.posted(incidents)).toHaveLength(3));
    expect(slack.posted(incidents)[2]).toMatchObject({
      thread: existing.split(":")[1],
      text: `**${handle}:** written after the join`,
    });
    expect(
      (await owner.poll({ re: other.id, after: other.id })).events.map((event) => event.type),
    ).toContain("thread.synced");

    // A platform thread syncs with one thread only.
    const third = await ada.post(channel, "a third thread");
    // A thread that exists in a Slack channel the entry maps nowhere is an owner's to join:
    // joining it listens to a channel nobody mapped. Starting one there takes only `sync`.
    const { client: member } = await vibe.join();
    const theirs = await member.post(channel, "a member's own");
    const said = slack.posted(incidents)[0]?.ts;
    expect(await failing(member.sync(theirs.id, `${key}:${incidents}:${said}`))).toBe("forbidden");
    expect(await failing(owner.sync(third.id, `${key}:${existing}`))).toBe("already_synced");
    expect(await failing(owner.sync(third.id, "no-such-entry:#x"))).toBe("source_not_found");
    expect(await failing(owner.sync(third.id, `${key}:#no-such-channel`))).toBe("invalid_target");
    expect(await failing(owner.sync(third.id, key))).toBe("invalid_target");
    expect(await failing(owner.sync("msg_nosuchmessage", `${key}:${incidents}`))).toBe(
      "message_not_found",
    );
  });

  test("a post can start in Slack as it starts here", async () => {
    const { owner, key } = await mapped();
    const { client: ada, handle } = await vibe.join();
    const incidents = slack.channel(vibe.name("incidents"));
    const channel = vibe.channel("unmapped");

    const root = await ada.post(channel, "checkout is down", { sync: `${key}:${incidents}` });
    await eventually(vibe, () => expect(slack.posted(incidents)).toHaveLength(1));
    expect(slack.posted(incidents)[0]?.text).toBe(`**${handle}:** checkout is down`);
    expect((await owner.sync(root.id)).targets).toMatchObject([{ source: key, state: "synced" }]);

    // What would be refused once the post had landed is refused before it is made.
    expect(await failing(ada.post(channel, "nowhere", { sync: "no-such-entry:#x" }))).toBe(
      "source_not_found",
    );
    const taken = `${key}:${incidents}:${slack.posted(incidents)[0]?.ts}`;
    expect(await failing(owner.post(channel, "taken", { sync: taken }))).toBe("already_synced");
    expect((await owner.threads({ channel })).threads).toHaveLength(1);
  });

  test("sync, the permission, decides who joins threads and where an entry writes", async () => {
    const { owner, source, key, service, channel, slackChannel } = await mapped();
    const { client: ada, handle } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const closed = vibe.channel("closed");
    const incidents = slack.channel(vibe.name("incidents"));
    const root = await ada.post(closed, "not for slack");

    // A viewer's role holds no sync, and a grant can take it from anyone.
    expect(await failing(viewer.sync(root.id, `${key}:${incidents}`))).toBe("forbidden");
    const grants = [
      await owner.createGrant({
        principals: [{ kind: "user", handle }],
        can: { [closed]: WITHOUT_SYNC },
      }),
    ];
    expect(await failing(ada.sync(root.id, `${key}:${incidents}`))).toBe("forbidden");
    expect(await failing(ada.post(closed, "nor this", { sync: `${key}:${incidents}` }))).toBe(
      "forbidden",
    );

    // The entry syncs where its service may. Without sync there, nothing is joined,
    // nothing goes out, and nothing comes in.
    grants.push(
      await owner.createGrant({
        principals: [{ kind: "service", name: service }],
        can: { [closed]: WITHOUT_SYNC, [channel]: WITHOUT_SYNC },
      }),
    );
    try {
      expect(await failing(owner.sync(root.id, `${key}:${incidents}`))).toBe("forbidden");
      await ada.post(channel, "written while the service may not sync");
      const said = slack.said({ channel: slackChannel, user: slack.user("Malte"), text: "hello?" });
      await deliver(vibe, source, slack.signed(said));
      await settle(vibe);
      expect(slack.posted(slackChannel)).toEqual([]);
      expect((await owner.threads({ channel, source: key })).threads).toEqual([]);
      expect((await owner.inbox(key))[0]).toMatchObject({
        event: "message",
        state: "ignored",
        note: expect.stringContaining("holds no sync"),
      });
    } finally {
      for (const grant of grants) await owner.revokeGrant(grant.id).catch(() => {});
    }
  });

  test("the inbox shows what Slack sent, to those who hold sync everywhere", async () => {
    const { owner, source, key, slackChannel } = await mapped();
    const { client: viewer } = await vibe.join("viewer");
    const malte = slack.user("Malte");
    const first = slack.said({ channel: slackChannel, user: malte, text: "first" });
    await deliver(vibe, source, slack.signed(first));
    const joined = {
      type: "message",
      subtype: "channel_join",
      channel: slackChannel,
      user: malte,
      ts: slack.ts(),
      text: "joined",
    };
    await deliver(vibe, source, slack.signed(slack.event(joined)));
    // The entry's own post, as Slack reports it back.
    const echo = {
      type: "message",
      channel: slackChannel,
      bot_id: slack.self.bot,
      ts: slack.ts(),
      text: "from vibe",
    };
    await deliver(vibe, source, slack.signed(slack.event(echo)));

    const inbox = await owner.inbox(key);
    expect(inbox.map((entry) => [entry.event, entry.state])).toEqual([
      ["message", "ignored"],
      ["message.channel_join", "ignored"],
      ["message", "done"],
    ]);
    expect(inbox[0]?.note).toBe("The entry's own message.");
    expect(inbox[2]).toMatchObject({ id: first.event_id, body: { event: { text: "first" } } });
    expect(await owner.inbox(key, { limit: 1 })).toHaveLength(1);

    expect(await failing(viewer.inbox(key))).toBe("forbidden");
    expect(await failing(owner.as("agent", { can: { "*": "all" } }).inbox(key))).toBe("forbidden");
    expect(await failing(owner.inbox("no-such-entry"))).toBe("source_not_found");
  });

  test("the inbox is closed to whoever can't read a thread that was joined to Slack by hand", async () => {
    const { owner, source, key, service } = await mapped();
    const { client: member } = await vibe.join();
    const me = (await owner.whoami()).actor.handle;
    // A channel only the owner and the entry's service use, which no mapping names.
    const secret = vibe.channel("private");
    const grants = [
      await owner.createGrant({
        principals: [
          { kind: "user", handle: me },
          { kind: "service", name: service },
        ],
        can: { [secret]: "all" },
      }),
      await owner.createGrant({ principals: [{ kind: "everyone" }], can: { [secret]: "none" } }),
    ];
    try {
      // Before any thread is joined, a member who reads what the entry maps reads its inbox.
      expect(await member.inbox(key)).toEqual([]);

      const incidents = slack.channel(vibe.name("incidents"));
      const root = await owner.post(secret, "the acquisition", { sync: `${key}:${incidents}` });
      await eventually(vibe, () => expect(slack.posted(incidents)).toHaveLength(1));
      const started = slack.posted(incidents)[0]?.ts ?? "";
      const reply = slack.said({
        channel: incidents,
        user: slack.user("Malte"),
        text: "the price is forty million",
        thread_ts: started,
      });
      await deliver(vibe, source, slack.signed(reply));
      expect((await owner.thread(root.id)).replies.map((each) => each.text)).toEqual([
        "the price is forty million",
      ]);

      // The reply landed in a channel the member can't read, so neither can they read it raw.
      expect(await failing(member.inbox(key))).toBe("forbidden");
      expect(JSON.stringify(await owner.inbox(key))).toContain("forty million");
    } finally {
      for (const grant of grants) await owner.revokeGrant(grant.id);
    }
  });

  test("a reaction made before a message has reached Slack is on it once it has", async () => {
    const { owner, channel, slackChannel } = await mapped();
    const { client: ada } = await vibe.join();
    // Written and reacted to before sync has had a chance to send it.
    const root = await ada.post(channel, "ship it?");
    await owner.react(root.id, "eyes");

    const [copy] = await eventually(vibe, () => {
      expect(slack.posted(slackChannel)).toHaveLength(1);
      return slack.posted(slackChannel);
    });
    await eventually(vibe, () =>
      expect(slack.reactions).toContainEqual({
        channel: slackChannel,
        ts: copy?.ts ?? "",
        name: "eyes",
      }),
    );
    // Once, however many passes follow.
    await settle(vibe);
    expect(slack.reactions.filter((each) => each.ts === copy?.ts)).toHaveLength(1);
    await owner.react(root.id, "eyes", { remove: true });
    await eventually(vibe, () =>
      expect(slack.reactions.filter((each) => each.ts === copy?.ts)).toEqual([]),
    );
  });

  test.skipIf(vibe.restartedWith === null)(
    "after the operator's secret changes, an entry is given its credentials whole and keeps its threads",
    async () => {
      const { owner, source, key, channel, slackChannel } = await mapped();
      const malte = slack.user("Malte");
      const first = slack.said({ channel: slackChannel, user: malte, text: "before the change" });
      await deliver(vibe, source, slack.signed(first));
      const [thread] = (await owner.threads({ channel })).threads;

      // The same Vibe, started with another secret: what it sealed opens for no one.
      const restarted = vibe.restartedWith?.("another-operator-secret");
      if (!restarted) throw new Error("This Vibe can't be restarted.");
      // Any owner of the team may do it. One whose token this test holds.
      const { token } = await vibe.join("owner");
      const after = connect({ url: vibe.url, token, fetch: restarted, live: false });
      const send = (signed: { body: string; headers: Record<string, string> }) =>
        restarted(`${vibe.url}/v1/sync/webhooks/${source.id}`, {
          method: "POST",
          headers: signed.headers,
          body: signed.body,
        });

      // Half of them is not enough: the other half can't be read to keep.
      expect(await failing(after.updateSourceCredentials(key, { token: slack.token }))).toBe(
        "invalid_source",
      );
      // Given whole, they are sealed under the new key, and the entry is the same entry.
      const renewed = await after.updateSourceCredentials(key, {
        token: slack.token,
        secret: slack.signingSecret,
      });
      expect(renewed.id).toBe(source.id);

      const reply = slack.said({
        channel: slackChannel,
        user: malte,
        text: "after the change",
        thread_ts: (first.event as { ts: string }).ts,
      });
      expect((await send(slack.signed(reply))).status).toBe(200);
      // The reply joined the thread it belongs to: the entry kept what it syncs with.
      const detail = await after.thread(thread?.message.id ?? "");
      expect(detail.replies.map((each) => each.text)).toEqual(["after the change"]);
    },
  );

  test("a reply in a Slack thread that began before the mapping brings the thread in", async () => {
    const { owner, source, channel, slackChannel } = await mapped();
    const malte = slack.user("Malte");
    const root = { type: "message", user: malte, text: "an old thread", ts: slack.ts() };
    slack.history.set(`${slackChannel}:${root.ts}`, { ...root, thread_ts: root.ts });

    const reply = slack.said({
      channel: slackChannel,
      user: slack.user("Lee"),
      text: "still relevant",
      thread_ts: root.ts,
    });
    await deliver(vibe, source, slack.signed(reply));

    const [thread] = (await owner.threads({ channel })).threads;
    expect(thread).toMatchObject({
      message: { text: "an old thread", by: { name: "Malte" } },
      replies: 1,
    });
    expect(thread?.last).toMatchObject({ text: "still relevant", by: { name: "Lee" } });
  });

  test("other apps' messages sync too, and what was said in one Slack thread reaches another", async () => {
    const { owner, source, key, channel, slackChannel } = await mapped();
    const elsewhere = slack.channel(vibe.name("elsewhere"));
    const alert = {
      type: "message",
      subtype: "bot_message",
      channel: slackChannel,
      bot_id: "B0SENTRY",
      username: "Sentry",
      text: "TypeError in checkout",
      ts: slack.ts(),
    };
    await deliver(vibe, source, slack.signed(slack.event(alert)));
    const [thread] = (await owner.threads({ channel })).threads;
    expect(thread?.message).toMatchObject({
      text: "TypeError in checkout",
      by: { name: "Sentry" },
      from: key,
    });

    // The thread also goes to a second Slack channel, which gets it from its root.
    await owner.sync(thread?.message.id ?? "", `${key}:${elsewhere}`);
    await eventually(vibe, () => expect(slack.posted(elsewhere)).toHaveLength(1));
    const reply = slack.said({
      channel: slackChannel,
      user: slack.user("Malte"),
      text: "on it",
      thread_ts: alert.ts,
    });
    await deliver(vibe, source, slack.signed(reply));
    await eventually(vibe, () => expect(slack.posted(elsewhere)).toHaveLength(2));
    const via = thread?.message.by.handle.split("/")[0] ?? "";
    expect(slack.posted(elsewhere).map((message) => message.text)).toEqual([
      `**Sentry via ${via}:** TypeError in checkout`,
      `**Malte via ${via}:** on it`,
    ]);
    // It reaches every thread it syncs with except the one it came from.
    expect(slack.posted(slackChannel)).toEqual([]);
  });

  test("a webhook that Slack didn't sign is refused, and changes nothing", async () => {
    const { owner, source, channel, slackChannel } = await mapped();
    const event = slack.said({ channel: slackChannel, user: slack.user("Eve"), text: "let me in" });

    const forged = await vibe.webhook(source, slack.signed(event, { secret: "not-the-secret" }));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ code: "webhook_refused" });

    // A real signature over another body.
    const real = slack.signed(event);
    const altered = { ...real, body: real.body.replace("let me in", "let me in!") };
    expect((await vibe.webhook(source, altered)).status).toBe(401);

    // A real request, replayed ten minutes later.
    const old = slack.signed(event, { at: Math.floor(vibe.now() / 1000) - 600 });
    expect((await vibe.webhook(source, old)).status).toBe(401);

    const unsigned = { body: real.body, headers: { "content-type": "application/json" } };
    expect((await vibe.webhook(source, unsigned)).status).toBe(401);
    expect((await vibe.webhook({ id: "src_nosuchentry" }, real)).status).toBe(404);

    expect((await owner.threads({ channel })).threads).toEqual([]);
    expect(await failing(owner.inbox(source.key))).toBe("nothing");
    expect(await owner.inbox(source.key)).toEqual([]);
  });
  test("what Slack says elsewhere is not kept, and the inbox is for those who read what it maps", async () => {
    const { owner, source, key, channel, slackChannel } = await mapped();
    const elsewhere = slack.channel(vibe.name("vibe-only"));
    const malte = slack.user("Malte");
    await deliver(
      vibe,
      source,
      slack.signed(slack.said({ channel: slackChannel, user: malte, text: "for the vibe" })),
    );
    // The app is in a channel the entry maps nowhere. Slack tells Vibe of it all the same.
    await deliver(
      vibe,
      source,
      slack.signed(
        slack.said({ channel: elsewhere, user: malte, text: "we are acquiring Initech" }),
      ),
    );
    const inbox = await owner.inbox(key);
    expect(inbox.map((entry) => entry.state)).toEqual(["ignored", "done"]);
    expect(JSON.stringify(inbox)).not.toContain("Initech");
    expect(inbox[1]).toMatchObject({ body: { event: { text: "for the vibe" } } });
    // The token Slack still sends beside its signature is the app's, and is not kept.
    expect(JSON.stringify(inbox)).not.toContain("deprecated-verification-token");

    // An event holds what was written in a mapped channel: without `read` there, no inbox.
    const { client: ada, handle } = await vibe.join();
    expect(await ada.inbox(key)).toHaveLength(2);
    const grant = await owner.createGrant({
      principals: [{ kind: "user", handle }],
      can: { [channel]: "none" },
    });
    try {
      expect(await failing(ada.inbox(key))).toBe("forbidden");
    } finally {
      await owner.revokeGrant(grant.id);
    }

    // Where an entry sends is shown to whoever lists it, and can't be changed after.
    const [listed] = (await ada.sources()).filter((each) => each.key === key);
    expect(listed?.api).toBe(vibe.platformApi("slack") ?? "https://slack.com/api");
  });

  test("replies that wait for their thread hold nothing else up", async () => {
    const { owner, key, channel, slackChannel } = await mapped();
    const elsewhere = slack.channel(vibe.name("elsewhere"));
    const side = vibe.channel("side");
    const { client: ada, handle } = await vibe.join();
    const root = await ada.post(side, "a thread with many replies");
    for (let n = 0; n < 25; n++) await ada.reply(root.id, `reply ${n}`);
    await settle(vibe);

    // Slack refuses the root once, and its copy waits for its next attempt. The
    // replies wait for it, more of them than one pass takes up.
    vibe.platforms.fail(1, { matching: "chat.postMessage" });
    await owner.sync(root.id, `${key}:${elsewhere}`);
    await vibe.tick();
    expect(slack.posted(elsewhere)).toEqual([]);

    // Someone writes in the mapped channel. It goes out in the next passes, ahead
    // of them, and well before the root's next attempt is due.
    await ada.post(channel, "urgent: the site is down");
    for (let pass = 0; pass < 3; pass++) await vibe.tick();
    expect(slack.posted(slackChannel).map((message) => message.text)).toEqual([
      `**${handle}:** urgent: the site is down`,
    ]);
  });

  test("what is written here pages no one in Slack, and a reader under a limit sees where a thread goes", async () => {
    const { owner, key, channel, slackChannel } = await mapped();
    const root = await owner.post(channel, "<!channel> <@U0VICTIM> @here, the build is red");
    const [sent] = await eventually(vibe, () => {
      expect(slack.posted(slackChannel)).toHaveLength(1);
      return slack.posted(slackChannel);
    });
    expect(sent?.text).toEndWith(
      "<\u200b!channel> <\u200b@U0VICTIM> @\u200bhere, the build is red",
    );

    // An agent held to reading is told where the thread it reads is synced: its
    // words would go there too. The event log says as much.
    const reader = owner.as("agent", { can: { [channel]: ["read"] } });
    expect((await reader.thread(root.id)).sync?.targets).toMatchObject([{ source: key }]);
    expect((await reader.sync(root.id)).targets).toMatchObject([{ source: key }]);
    expect(await failing(reader.sync(root.id, `${key}:${slackChannel}`))).toBe("forbidden");
    expect(await failing(reader.sources())).toBe("forbidden");
  });
});
