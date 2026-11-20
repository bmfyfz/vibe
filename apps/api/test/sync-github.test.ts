import { afterAll, describe, expect, test } from "bun:test";

import { harness } from "./harness.ts";
import { deliver, eventually, failing, settle, syncEntries } from "./sync-helpers.ts";

const vibe = harness();
const { github } = vibe.platforms;

describe.skipIf(!vibe.near)("sync with GitHub", () => {
  const entries = syncEntries(vibe);
  afterAll(() => entries.removeAll());

  /** Sends one of GitHub's events about a repository to an entry. */
  const sent = (
    source: { id: string },
    repository: string,
    event: string,
    payload: Record<string, unknown>,
  ) => deliver(vibe, source, github.signed(event, { ...github.about(repository), ...payload }));

  test("a pull request becomes a thread, with its state as the root's labels", async () => {
    const repository = github.repository("www");
    const channel = vibe.channel("prs");
    // Inbound only: no token is needed to bring pull requests and issues in.
    const { owner, source, key, service } = await entries.add(
      "github",
      { [repository]: channel },
      { token: null },
    );
    const author = github.account("ada-lovelace", 4242);
    const pull = github.pull(repository, 12, {
      title: "Fix the checkout timeout",
      body: "Raises the limit.\n\n<!-- a template's comment -->",
      draft: true,
      user: author,
      labels: [{ name: "bug" }, { name: "Good First Issue" }],
      assignees: [github.account("grace")],
      head: { sha: "f00dfeed".repeat(5), ref: "fix" },
    });
    await sent(source, repository, "pull_request", {
      action: "opened",
      number: 12,
      pull_request: pull,
    });

    const [thread] = (await owner.threads({ channel })).threads;
    const root = thread?.message;
    expect(root).toMatchObject({
      text: "**Fix the checkout timeout**\n\nRaises the limit.",
      from: key,
      by: { name: "ada-lovelace", handle: `${service}/u-ada-lovelace` },
      labels: {
        pr: `${repository}#12`,
        state: "draft",
        head: "f00dfeed".repeat(5),
        "tag.bug": "bug",
        "tag.good-first-issue": "Good First Issue",
        "assignee.grace": "grace",
      },
    });
    expect((await owner.sync(root?.id ?? "")).targets).toMatchObject([
      { source: key, platform: "github", target: `${key}:${repository}#12`, state: "synced" },
    ]);

    // Its state moves on GitHub, and the labels follow: an agent can wait on them.
    const ready = { ...pull, draft: false, labels: [{ name: "bug" }], assignees: [] };
    await sent(source, repository, "pull_request", {
      action: "ready_for_review",
      number: 12,
      pull_request: ready,
    });
    expect((await owner.thread(root?.id ?? "")).message.labels).toEqual({
      pr: `${repository}#12`,
      state: "open",
      head: "f00dfeed".repeat(5),
      "tag.bug": "bug",
    });

    const review = { id: 801, state: "approved", body: "Ship it.", user: github.account("grace") };
    await sent(source, repository, "pull_request_review", {
      action: "submitted",
      pull_request: ready,
      review,
    });
    const merged = { ...ready, state: "closed", merged: true };
    await sent(source, repository, "pull_request", {
      action: "closed",
      number: 12,
      pull_request: merged,
    });
    const after = await owner.thread(root?.id ?? "");
    expect(after.message.labels).toMatchObject({ state: "merged", review: "approved" });
    expect(after.replies.map((reply) => [reply.by.name, reply.text])).toEqual([
      ["grace", "**Approved**\n\nShip it."],
    ]);
    expect((await owner.threads({ channel, label: { review: "approved" } })).threads).toHaveLength(
      1,
    );

    // A dismissed review takes its verdict with it. Labels people set stay.
    await owner.label(root?.id ?? "", { set: { owner: "fx" } });
    await sent(source, repository, "pull_request_review", {
      action: "dismissed",
      pull_request: merged,
      review: { ...review, state: "dismissed" },
    });
    const labels = (await owner.thread(root?.id ?? "")).message.labels;
    expect(labels["review"]).toBeUndefined();
    expect(labels).toMatchObject({ owner: "fx", state: "merged" });
  });

  test("comments, reviews and inline comments arrive as replies, and follow their edits", async () => {
    const repository = github.repository("api");
    const channel = vibe.channel("prs");
    const { owner, source } = await entries.add(
      "github",
      { [repository]: channel },
      { token: null },
    );
    const pull = github.pull(repository, 7, { title: "Add retries" });
    const grace = github.account("grace");
    const comment = {
      id: 5501,
      body: "Does this back off?",
      user: grace,
      html_url: `https://github.com/${repository}/pull/7#issuecomment-5501`,
    };

    // The pull request was opened before the repository was mapped: its first
    // comment brings the thread in, from what the event says of it.
    await sent(source, repository, "issue_comment", {
      action: "created",
      issue: { ...github.issue(repository, 7, { title: "Add retries" }), pull_request: {} },
      comment,
    });
    const [thread] = (await owner.threads({ channel })).threads;
    expect(thread?.message).toMatchObject({
      text: "**Add retries**",
      labels: { pr: `${repository}#7`, state: "open" },
    });

    const inline = { id: 6601, body: "Off by one.", path: "src/retry.ts", user: grace };
    await sent(source, repository, "pull_request_review_comment", {
      action: "created",
      pull_request: pull,
      comment: inline,
    });
    await sent(source, repository, "issue_comment", {
      action: "edited",
      issue: { ...github.issue(repository, 7), pull_request: {} },
      comment: { ...comment, body: "Does this back off? (it does)" },
      changes: { body: { from: comment.body } },
    });
    const replies = (await owner.thread(thread?.message.id ?? "")).replies;
    expect(replies.map((reply) => reply.text)).toEqual([
      "Does this back off? (it does)",
      "Off by one.\n\n_on `src/retry.ts`_",
    ]);
    expect(replies[0]?.revision).toBe(2);

    await sent(source, repository, "pull_request_review_comment", {
      action: "deleted",
      pull_request: pull,
      comment: inline,
    });
    expect((await owner.thread(thread?.message.id ?? "")).replies[1]?.deletedAt).not.toBeNull();
    // GitHub sends the same delivery again when asked to. It comes in once.
    const again = github.signed(
      "issue_comment",
      {
        ...github.about(repository),
        action: "created",
        issue: github.issue(repository, 7),
        comment,
      },
      { delivery: "11111111-2222-3333-4444-555555555555" },
    );
    await deliver(vibe, source, again);
    await deliver(vibe, source, again);
    expect((await owner.thread(thread?.message.id ?? "")).replies).toHaveLength(2);
  });

  test("a repository's pull requests and issues can go to channels of their own", async () => {
    const repository = github.repository("split");
    const pulls = vibe.channel("prs");
    const issues = vibe.channel("issues");
    const { owner, source } = await entries.add(
      "github",
      { [repository]: { pulls, issues } },
      { token: null },
    );
    await sent(source, repository, "pull_request", {
      action: "opened",
      number: 1,
      pull_request: github.pull(repository, 1),
    });
    const issue = github.issue(repository, 2, { title: "Docs are stale", body: "See README." });
    await sent(source, repository, "issues", { action: "opened", issue });
    await sent(source, repository, "issues", {
      action: "closed",
      issue: { ...issue, state: "closed" },
    });

    expect((await owner.threads({ channel: pulls })).threads).toHaveLength(1);
    const [thread] = (await owner.threads({ channel: issues })).threads;
    expect(thread?.message).toMatchObject({
      text: "**Docs are stale**\n\nSee README.",
      labels: { issue: `${repository}#2`, state: "closed" },
    });
    // An event about a repository that isn't mapped is taken, and brings nothing in.
    const other = github.repository("unmapped");
    await sent(source, other, "issues", { action: "opened", issue: github.issue(other, 1) });
    expect((await owner.inbox(source.key))[0]).toMatchObject({
      event: "issues.opened",
      state: "ignored",
    });
  });

  test("a delivery that GitHub didn't sign is refused, and changes nothing", async () => {
    const repository = github.repository("www");
    const channel = vibe.channel("prs");
    const { owner, source } = await entries.add(
      "github",
      { [repository]: channel },
      { token: null },
    );
    const payload = {
      ...github.about(repository),
      action: "opened",
      number: 1,
      pull_request: github.pull(repository, 1),
    };

    const forged = await vibe.webhook(
      source,
      github.signed("pull_request", payload, { secret: "guess" }),
    );
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ code: "webhook_refused" });

    const real = github.signed("pull_request", payload);
    const altered = { ...real, body: real.body.replace("Pull request 1", "Pull request 9") };
    expect((await vibe.webhook(source, altered)).status).toBe(401);
    // The older SHA-1 signature alone is not taken.
    const { "x-hub-signature-256": _, ...unsigned } = real.headers;
    expect(
      (
        await vibe.webhook(source, {
          ...real,
          headers: { ...unsigned, "x-hub-signature": "sha1=0" },
        })
      ).status,
    ).toBe(401);

    expect((await owner.threads({ channel })).threads).toEqual([]);
    // A ping is GitHub's, and is taken: it shows in the inbox that the webhook reaches the entry.
    await deliver(
      vibe,
      source,
      github.signed("ping", { zen: "Keep it logically awesome.", hook_id: 1 }),
    );
    expect((await owner.inbox(source.key))[0]).toMatchObject({ event: "ping", state: "ignored" });
  });

  test("nothing goes back to GitHub unless a repository says replies do, and then only what was written here", async () => {
    const quiet = github.repository("quiet");
    const open = github.repository("open");
    const channel = vibe.channel("prs");
    const { owner, source, key } = await entries.add("github", {
      [quiet]: channel,
      [open]: { channel, replies: true },
    });
    const { client: ada, handle } = await vibe.join();
    for (const repository of [quiet, open]) {
      await sent(source, repository, "issues", {
        action: "opened",
        issue: github.issue(repository, 3, { title: `In ${repository}` }),
      });
    }
    const { threads } = await owner.threads({ channel });
    const inQuiet = threads.find((thread) => thread.message.text.includes(quiet))?.message;
    const inOpen = threads.find((thread) => thread.message.text.includes(open))?.message;

    await ada.reply(inQuiet?.id ?? "", "said on the vibe");
    const reply = await ada.reply(inOpen?.id ?? "", "said on the vibe, for GitHub too");
    const comments = await eventually(vibe, () => {
      expect(github.comments.size).toBeGreaterThanOrEqual(1);
      return [...github.comments.values()].filter((comment) => comment.repository === open);
    });
    await settle(vibe);
    expect([...github.comments.values()].filter((comment) => comment.repository === quiet)).toEqual(
      [],
    );
    expect(comments).toMatchObject([{ number: 3 }]);
    expect(comments[0]?.body).toBe(
      `**${handle}** wrote:\n\nsaid on the vibe, for GitHub too\n\n<!-- vibe:${reply.id} -->`,
    );

    // GitHub reports the comment back. It is the entry's own, and is not brought in again.
    const [id] = [...github.comments.keys()];
    await sent(source, open, "issue_comment", {
      action: "created",
      issue: github.issue(open, 3),
      comment: { id, body: comments[0]?.body, user: github.self },
    });
    expect((await owner.thread(inOpen?.id ?? "")).replies).toHaveLength(1);

    // What came from GitHub is not sent back to it, and an edit here follows there.
    await sent(source, open, "issue_comment", {
      action: "created",
      issue: github.issue(open, 3),
      comment: { id: 7001, body: "said on GitHub", user: github.account("grace") },
    });
    await ada.edit(reply.id, "said better");
    await eventually(vibe, () =>
      expect(github.comments.get(id ?? 0)?.body).toContain("said better"),
    );
    expect(github.comments.size).toBe(1);

    // A thread on the vibe never opens an issue or a pull request.
    const fresh = await ada.post(channel, "a thread of the vibe's own");
    await settle(vibe);
    expect((await owner.sync(fresh.id)).targets).toEqual([]);
    expect(await failing(owner.sync(fresh.id, `${key}:${open}`))).toBe("invalid_target");
    // Sending replies back takes a token.
    expect(
      await failing(
        owner.createSource({
          key: vibe.name("gh"),
          platform: "github",
          service: source.service.handle,
          map: { [open]: { channel, replies: true } },
          credentials: { secret: github.webhookSecret },
          api: vibe.platformApi("github"),
        }),
      ),
    ).toBe("invalid_source");
  });

  test("a thread joins a pull request's conversation, which then comes in", async () => {
    const repository = github.repository("joined");
    const { owner, source, key } = await entries.add("github", {}, { token: null });
    const { client: ada } = await vibe.join();
    const channel = vibe.channel("incidents");
    const root = await ada.post(channel, "tracking the fix here");

    expect(await owner.sync(root.id, `${key}:${repository}:44`)).toEqual({
      target: `${key}:${repository}#44`,
      attached: true,
    });
    await sent(source, repository, "issue_comment", {
      action: "created",
      issue: { ...github.issue(repository, 44), pull_request: {} },
      comment: { id: 8101, body: "Deployed to staging.", user: github.account("grace") },
    });
    const thread = await owner.thread(root.id);
    expect(thread.replies.map((reply) => reply.text)).toEqual(["Deployed to staging."]);
    // The root is the vibe's own, and stays as it was written.
    expect(thread.message.text).toBe("tracking the fix here");
    // Nothing is sent back: the repository's mapping would have to say so.
    await ada.reply(root.id, "thanks");
    await settle(vibe);
    expect([...github.comments.values()].filter((each) => each.repository === repository)).toEqual(
      [],
    );
    const other = await ada.post(channel, "another thread");
    expect(await failing(owner.sync(other.id, `${key}:${repository}#44`))).toBe("already_synced");
  });
  test("a thread joins a platform channel only for someone who reads what comes in from it", async () => {
    const repository = github.repository("secret");
    const unmapped = github.repository("elsewhere");
    const closed = vibe.channel("secret");
    const open = vibe.channel("open");
    const { owner, source, key } = await entries.add(
      "github",
      { [repository]: closed },
      { token: null },
    );
    const { client: mallory, handle } = await vibe.join();
    const grant = await owner.createGrant({
      principals: [{ kind: "user", handle }],
      can: { [closed]: "none" },
    });
    try {
      // She may sync in a channel of her own. That says nothing of the repository's side:
      // a pull request's reviews would come into her thread, out of a channel closed to her.
      const bait = await mallory.post(open, "nothing to see here");
      expect(await failing(mallory.sync(bait.id, `${key}:${repository}:42`))).toBe("forbidden");
      expect(
        await failing(mallory.post(open, "nor here", { sync: `${key}:${repository}:42` })),
      ).toBe("forbidden");
      // A repository the entry maps nowhere is refused in the same words.
      expect(await failing(mallory.sync(bait.id, `${key}:${unmapped}:1`))).toBe("forbidden");

      const pull = github.pull(repository, 42, { title: "Rotate the signing key" });
      await sent(source, repository, "pull_request", {
        action: "opened",
        number: 42,
        pull_request: pull,
      });
      await sent(source, repository, "pull_request_review", {
        action: "submitted",
        pull_request: pull,
        review: {
          id: 4200,
          state: "approved",
          body: "The key is in the vault under ops/signing.",
          user: github.account("grace"),
        },
      });
      const [thread] = (await owner.threads({ channel: closed })).threads;
      expect(thread?.message.labels).toMatchObject({ review: "approved" });
      expect((await mallory.thread(bait.id)).replies).toEqual([]);

      // Someone who reads and syncs the mapped channel joins a thread to it, and an owner to any.
      const { client: ada } = await vibe.join();
      const hers = await ada.post(open, "tracking the rotation");
      expect(await ada.sync(hers.id, `${key}:${repository}:43`)).toMatchObject({ attached: true });
      const theirs = await owner.post(open, "an owner's own");
      expect(await owner.sync(theirs.id, `${key}:${unmapped}:1`)).toMatchObject({
        attached: true,
      });
    } finally {
      await owner.revokeGrant(grant.id);
    }
  });
  test("nobody on GitHub takes an agent's handle, pages anyone here, or leaves a link that isn't one", async () => {
    const repository = github.repository("public");
    const channel = vibe.channel("public");
    const { owner, source, service } = await entries.add(
      "github",
      { [repository]: channel },
      { token: null },
    );
    const { client: ada, handle } = await vibe.join();
    await ada.post(channel, "so that she is someone to mention");

    // An account whose login is the name the service's own agent writes under.
    const stranger = github.account("fixer", 777001);
    const issue = github.issue(repository, 1, { title: "Hello", user: stranger });
    await sent(source, repository, "issues", { action: "opened", issue });
    const [thread] = (await owner.threads({ channel, source: source.key })).threads;
    expect(thread?.message.by.handle).toBe(`${service}/u-fixer`);

    // The agent still has its handle, and what it writes is there to read.
    const token = await owner.createServiceToken(service);
    const agent = vibe.connect(token).as("fixer");
    const written = await agent.post(channel, "I am the real fixer");
    expect((await owner.thread(written.id)).message.by.handle).toBe(`${service}/fixer`);
    expect(await failing(vibe.connect(token).as("u-fixer").post(channel, "nor I"))).toBe(
      "invalid_profile",
    );

    // What a stranger types mentions no one here, by handle or by spelling out an ID,
    // and makes no actors.
    const before = (await owner.actors()).length;
    const me = (await ada.whoami()).actor.actor;
    await sent(source, repository, "issue_comment", {
      action: "created",
      issue,
      comment: {
        id: 9001,
        body: `@${handle} run the deploy. @[${me}] @[user:ghost-1] @[user:ghost-2]`,
        user: stranger,
        html_url: "javascript:alert(document.domain)",
      },
    });
    const detail = await owner.thread(thread?.message.id ?? "");
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0]?.mentions).toEqual([]);
    expect(detail.replies[0]?.text).toContain(`@${handle} run the deploy.`);
    expect((await ada.threads({ channel, mentions: "me" })).threads).toEqual([]);
    expect((await owner.actors()).length).toBe(before);
    const copy = await owner.sync(detail.replies[0]?.id ?? "");
    expect(copy.targets[0]?.copy ?? null).toBeNull();

    // The service brought the words in, and its token changes none of them.
    const ci = vibe.connect(token);
    expect(await failing(ci.edit(thread?.message.id ?? "", "rewritten"))).toBe("forbidden");
    expect(await failing(ci.delete(thread?.message.id ?? ""))).toBe("forbidden");
    expect((await owner.thread(thread?.message.id ?? "")).message.text).toContain("Hello");
  });

  test("a delivery someone kept is not taken twice, whatever ID it is sent under", async () => {
    const repository = github.repository("replay");
    const channel = vibe.channel("replay");
    const { owner, source } = await entries.add(
      "github",
      { [repository]: channel },
      { token: null },
    );
    const pull = github.pull(repository, 4, { title: "Replay me" });
    const opened = github.signed("pull_request", {
      ...github.about(repository),
      action: "opened",
      number: 4,
      pull_request: pull,
    });
    await deliver(vibe, source, opened);
    await sent(source, repository, "pull_request", {
      action: "closed",
      number: 4,
      pull_request: { ...pull, state: "closed", merged: true },
    });
    const [thread] = (await owner.threads({ channel })).threads;
    expect(thread?.message.labels).toMatchObject({ state: "merged" });

    // GitHub signs the body alone. The same body under a new delivery ID is the same delivery.
    const again = {
      ...opened,
      headers: { ...opened.headers, "x-github-delivery": "00000000-0000-4000-8000-000000000000" },
    };
    expect((await vibe.webhook(source, again)).status).toBe(200);
    await settle(vibe);
    expect((await owner.thread(thread?.message.id ?? "")).message.labels).toMatchObject({
      state: "merged",
    });
    expect((await owner.threads({ channel })).threads).toHaveLength(1);
  });

  test("what is written here pages no one on GitHub, and a refusal that would repeat is not retried", async () => {
    const repository = github.repository("pings");
    const channel = vibe.channel("pings");
    const { owner, source } = await entries.add("github", {
      [repository]: { channel, replies: true },
    });
    const { client: ada, handle } = await vibe.join();
    await sent(source, repository, "issues", {
      action: "opened",
      issue: github.issue(repository, 9, { title: "Pings" }),
    });
    const [thread] = (await owner.threads({ channel })).threads;
    const root = thread?.message.id ?? "";
    const reply = await ada.reply(
      root,
      "cc @torvalds and @kubernetes/sig-release, see `npm i @scope/pkg`",
    );
    const [comment] = await eventually(vibe, () => {
      const made = [...github.comments.values()].filter((each) => each.repository === repository);
      expect(made).toHaveLength(1);
      return made;
    });
    expect(comment?.body).toBe(
      `**${handle}** wrote:\n\ncc @\u200btorvalds and @\u200bkubernetes/sig-release, see \`npm i @scope/pkg\`\n\n<!-- vibe:${reply.id} -->`,
    );

    // The issue is gone. Asking again would be answered the same, so it is recorded at once.
    vibe.platforms.fail(1, { matching: "/comments", status: 404 });
    const lost = await ada.reply(root, "into the void");
    await eventually(vibe, async () => {
      const synced = await owner.sync(root);
      expect(synced.failures).toMatchObject([{ message: lost.id }]);
    });
  });
});
