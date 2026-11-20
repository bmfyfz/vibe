import { afterAll, describe, expect, test } from "bun:test";

import { harness } from "./harness.ts";
import { deliver, eventually, failing, settle, syncEntries } from "./sync-helpers.ts";

const vibe = harness();
const { linear, slack, github } = vibe.platforms;

describe.skipIf(!vibe.near)("sync with Linear", () => {
  const entries = syncEntries(vibe);
  afterAll(() => entries.removeAll());

  /** A Linear team mapped to a vibe channel, both new. */
  async function mapped() {
    const team = linear.team();
    const channel = vibe.channel("dev");
    const syncing = await entries.add("linear", { [team.key]: channel });
    return { ...syncing, team, channel };
  }

  test("an issue becomes a thread, with its state as labels and its comments as replies", async () => {
    const { owner, source, key, service, team, channel } = await mapped();
    const malte = linear.person("Malte Ubl");
    const issue = linear.issue(team, 12, {
      title: "Checkout times out",
      description: "Since the last deploy.",
      state: { id: "s1", name: "In Progress", type: "started" },
      priority: 2,
      priorityLabel: "High",
      labels: [{ id: "l1", name: "Bug" }],
      assignee: { id: "u9", name: "Grace Hopper" },
      project: { id: "p1", name: "Q4 Reliability" },
    });
    await deliver(
      vibe,
      source,
      linear.signed({ action: "create", type: "Issue", data: issue, actor: malte, url: issue.url }),
    );

    const [thread] = (await owner.threads({ channel })).threads;
    const root = thread?.message;
    expect(root).toMatchObject({
      text: "**Checkout times out**\n\nSince the last deploy.",
      from: key,
      by: { name: "Malte Ubl", handle: `${service}/u-malte-ubl` },
      labels: {
        issue: `${team.key}-12`,
        state: "started",
        priority: "high",
        project: "Q4 Reliability",
        "tag.bug": "Bug",
        "assignee.grace-hopper": "Grace Hopper",
      },
    });

    const comment = { id: crypto.randomUUID(), body: "Reproduced on staging.", issueId: issue.id };
    await deliver(
      vibe,
      source,
      linear.signed({ action: "create", type: "Comment", data: comment, actor: malte }),
    );
    // The issue is done, and unassigned: the labels say so, and a waiting agent hears it.
    const done = {
      ...issue,
      state: { id: "s2", name: "Done", type: "completed" },
      assignee: null,
      labels: [],
    };
    await deliver(
      vibe,
      source,
      linear.signed({
        action: "update",
        type: "Issue",
        data: done,
        actor: malte,
        updatedFrom: { stateId: "s1" },
      }),
    );
    const after = await owner.thread(root?.id ?? "");
    expect(after.replies.map((reply) => [reply.by.name, reply.text])).toEqual([
      ["Malte Ubl", "Reproduced on staging."],
    ]);
    expect(after.message.labels).toEqual({
      issue: `${team.key}-12`,
      state: "completed",
      priority: "high",
      project: "Q4 Reliability",
    });
    expect(after.message.revision).toBe(1);

    // An edit of the issue's text is an edit of the root, and of a comment, of the reply.
    await deliver(
      vibe,
      source,
      linear.signed({
        action: "update",
        type: "Issue",
        data: { ...done, title: "Checkout timed out" },
        actor: malte,
        updatedFrom: { title: issue.title },
      }),
    );
    await deliver(
      vibe,
      source,
      linear.signed({
        action: "update",
        type: "Comment",
        data: { ...comment, body: "Reproduced on staging, twice." },
        actor: malte,
      }),
    );
    const edited = await owner.thread(root?.id ?? "");
    expect(edited.message.text).toStartWith("**Checkout timed out**");
    expect(edited.replies[0]?.text).toBe("Reproduced on staging, twice.");
    await deliver(
      vibe,
      source,
      linear.signed({ action: "remove", type: "Comment", data: comment, actor: malte }),
    );
    expect((await owner.thread(root?.id ?? "")).replies[0]?.deletedAt).not.toBeNull();
  });

  test("a new thread in a mapped channel opens an issue, and replies are its comments", async () => {
    const { owner, source, key, team, channel } = await mapped();
    const { client: ada, handle } = await vibe.join();

    const root = await ada.post(channel, "## Docs are *stale*\n\nThe README still says pipe.", {
      labels: { kind: "docs" },
    });
    const [issue] = await eventually(vibe, () => {
      const made = [...linear.issues.values()].filter((each) => each.teamId === team.id);
      expect(made).toHaveLength(1);
      return made;
    });
    // The first line is the title, and the whole message is the description.
    expect(issue).toMatchObject({
      title: "Docs are stale",
      description: `**${handle}** wrote:\n\n## Docs are *stale*\n\nThe README still says pipe.`,
    });
    expect(JSON.stringify(issue)).not.toContain("kind");

    const reply = await ada.reply(root.id, "Fixed in a1b2c3.");
    const [comment] = await eventually(vibe, () => {
      const made = [...linear.comments.values()].filter((each) => each.issueId === issue?.id);
      expect(made).toHaveLength(1);
      return made;
    });
    expect(comment?.body).toBe(`**${handle}** wrote:\n\nFixed in a1b2c3.`);
    expect((await owner.sync(reply.id)).targets).toMatchObject([
      { source: key, platform: "linear", target: `${key}:${issue?.id}`, state: "synced" },
    ]);

    // Linear tells of both, as it tells of anything. They are the entry's own
    // copies, known by the IDs it gave them, and are not brought in again.
    const actor = linear.viewer;
    await deliver(
      vibe,
      source,
      linear.signed({
        action: "create",
        type: "Issue",
        data: { ...linear.issue(team, 1), id: issue?.id, title: issue?.title },
        actor,
      }),
    );
    await deliver(
      vibe,
      source,
      linear.signed({ action: "create", type: "Comment", data: comment ?? {}, actor }),
    );
    expect((await owner.threads({ channel })).threads).toHaveLength(1);
    expect((await owner.thread(root.id)).replies).toHaveLength(1);

    // An edit and a delete here follow there.
    await ada.edit(reply.id, "Fixed in d4e5f6.");
    await eventually(vibe, () =>
      expect(linear.comments.get(comment?.id ?? "")?.body).toContain("Fixed in d4e5f6."),
    );
    await ada.delete(reply.id);
    await eventually(vibe, () => expect(linear.comments.has(comment?.id ?? "")).toBe(false));
  });

  test("a webhook that Linear didn't sign, or sent long ago, is refused", async () => {
    const { owner, source, team, channel } = await mapped();
    const payload = {
      action: "create",
      type: "Issue",
      data: linear.issue(team, 1),
      actor: linear.person("Eve"),
    };

    const forged = await vibe.webhook(source, linear.signed(payload, { secret: "guess" }));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ code: "webhook_refused" });
    const real = linear.signed(payload);
    const altered = { ...real, body: real.body.replace("create", "update") };
    expect((await vibe.webhook(source, altered)).status).toBe(401);
    // Signed by Linear, and replayed five minutes later.
    const old = linear.signed(payload, { at: vibe.now() - 5 * 60_000 });
    expect((await vibe.webhook(source, old)).status).toBe(401);
    const { "linear-signature": _, ...unsigned } = real.headers;
    expect((await vibe.webhook(source, { ...real, headers: unsigned })).status).toBe(401);

    expect((await owner.threads({ channel })).threads).toEqual([]);
  });

  test("a comment on an issue that isn't here yet brings the issue in first", async () => {
    const { owner, source, team, channel } = await mapped();
    const id = crypto.randomUUID();
    linear.issues.set(id, {
      id,
      identifier: `${team.key}-77`,
      teamId: team.id,
      title: "An older issue",
      description: "Filed before the team was mapped.",
      url: `https://linear.app/stub/issue/${team.key}-77`,
    });
    const comment = {
      id: crypto.randomUUID(),
      body: "Still happening.",
      issueId: id,
      issue: { id, title: "An older issue", teamId: team.id },
    };
    await deliver(
      vibe,
      source,
      linear.signed({
        action: "create",
        type: "Comment",
        data: comment,
        actor: linear.person("Lee"),
      }),
    );
    const [thread] = (await owner.threads({ channel })).threads;
    expect(thread).toMatchObject({
      message: {
        text: "**An older issue**\n\nFiled before the team was mapped.",
        labels: { issue: `${team.key}-77` },
      },
      replies: 1,
      last: { text: "Still happening.", by: { name: "Lee" } },
    });
  });

  test("an entry's credentials are replaced, and the platform is asked about them again", async () => {
    // Linear says what it signs with only once the webhook exists, and the
    // webhook needs the entry's address: so the entry starts with a stand-in.
    const team = linear.team();
    const channel = vibe.channel("dev");
    const by = await entries.owner();
    const service = vibe.name("svc");
    await by.createService({ name: service });
    const key = vibe.name("linear");
    const source = await by.createSource({
      key,
      platform: "linear",
      service,
      map: { [team.key]: channel },
      credentials: { token: linear.token, secret: "not-known-yet" },
      api: vibe.platformApi("linear"),
    });
    try {
      const issue = linear.issue(team, 3, { title: "Signed with the real secret" });
      const signed = () =>
        linear.signed({
          action: "create",
          type: "Issue",
          data: issue,
          actor: linear.person("Lee"),
        });
      expect((await vibe.webhook(source, signed())).status).toBe(401);

      const updated = await by.updateSourceCredentials(key, { secret: linear.webhookSecret });
      expect(updated.id).toBe(source.id);
      expect(JSON.stringify(updated)).not.toContain(linear.webhookSecret);
      await deliver(vibe, source, signed());
      expect((await by.threads({ channel })).threads).toHaveLength(1);

      // A token that doesn't work changes nothing: the entry goes on with the one it had.
      expect(await failing(by.updateSourceCredentials(key, { token: "lin_api_wrong" }))).toBe(
        "invalid_source",
      );
      const { client: ada } = await vibe.join();
      await ada.post(channel, "still syncing");
      await eventually(vibe, () =>
        expect([...linear.issues.values()].filter((each) => each.teamId === team.id)).toHaveLength(
          1,
        ),
      );
      expect(await failing(ada.updateSourceCredentials(key, { secret: "mine-now" }))).toBe(
        "forbidden",
      );
      expect(
        await failing(
          by.as("agent", { can: { "*": "all" } }).updateSourceCredentials(key, { secret: "x" }),
        ),
      ).toBe("forbidden");
      expect(await failing(by.updateSourceCredentials("no-such-entry", { secret: "x" }))).toBe(
        "source_not_found",
      );
    } finally {
      await by.deleteSource(key).catch(() => {});
    }
  });

  test("an entry needs a key Linear knows, and a team it can see", async () => {
    const { owner, source, key } = await mapped();
    const base = {
      platform: "linear" as const,
      service: source.service.handle,
      credentials: { token: linear.token, secret: linear.webhookSecret },
      api: vibe.platformApi("linear"),
    };
    expect(
      await failing(owner.createSource({ ...base, key: vibe.name("l"), map: { NOSUCH: "dev" } })),
    ).toBe("invalid_source");
    expect(
      await failing(
        owner.createSource({
          ...base,
          key: vibe.name("l"),
          credentials: { token: "lin_api_wrong", secret: "s" },
        }),
      ),
    ).toBe("invalid_source");
    expect(
      await failing(
        owner.createSource({ ...base, key: vibe.name("l"), credentials: { secret: "s" } }),
      ),
    ).toBe("invalid_source");
    const { client: ada } = await vibe.join();
    const root = await ada.post(vibe.channel(), "to be an issue");
    expect(await failing(owner.sync(root.id, `${key}:NOSUCH-1`))).toBe("invalid_target");
    expect(await failing(owner.sync(root.id, `${key}:NOSUCH`))).toBe("invalid_target");
  });

  test("what is said on one platform reaches the others the thread syncs with, and not where it came from", async () => {
    const { owner, key: linearKey, service, team, channel } = await mapped();
    const { client: ada, handle } = await vibe.join();
    const name = vibe.name("support");
    const slackChannel = slack.channel(name);
    const support = vibe.channel("support");
    // Both entries act as one service, as a team with one "support" bot would have it.
    const viaSlack = await entries.add("slack", { [`#${name}`]: support }, { service });

    // A customer writes in Slack. The thread comes in, and is also made a Linear issue.
    const malte = slack.user("Malte");
    const first = slack.said({ channel: slackChannel, user: malte, text: "the export is *empty*" });
    await deliver(vibe, viaSlack.source, slack.signed(first));
    const root = (await owner.threads({ channel: support })).threads[0]?.message;
    expect(await owner.sync(root?.id ?? "", `${linearKey}:${team.key}`)).toMatchObject({
      attached: true,
    });
    const [issue] = await eventually(vibe, () => {
      const made = [...linear.issues.values()].filter((each) => each.teamId === team.id);
      expect(made).toHaveLength(1);
      return made;
    });
    expect(issue).toMatchObject({
      title: "the export is empty",
      description: `**Malte via ${viaSlack.service}** wrote:\n\nthe export is **empty**`,
    });

    // Slack says more: it reaches Linear, and is not sent back to Slack.
    const more = slack.said({
      channel: slackChannel,
      user: malte,
      text: "since this morning",
      thread_ts: String(first.event["ts"]),
    });
    await deliver(vibe, viaSlack.source, slack.signed(more));
    const comments = () =>
      [...linear.comments.values()].filter((each) => each.issueId === issue?.id);
    await eventually(vibe, () => expect(comments()).toHaveLength(1));
    expect(comments()[0]?.body).toBe(
      `**Malte via ${viaSlack.service}** wrote:\n\nsince this morning`,
    );
    expect(slack.posted(slackChannel)).toEqual([]);
    // The comment is the vibe's copy of what Malte said. Someone changing it
    // in Linear doesn't change what Malte said.
    const tampered = { ...comments()[0], body: "since this morning (I never said this)" };
    await deliver(
      vibe,
      { id: (await owner.sources()).find((each) => each.key === linearKey)?.id ?? "" },
      linear.signed({ action: "update", type: "Comment", data: tampered, actor: linear.viewer }),
    );
    expect((await owner.thread(root?.id ?? "")).replies[0]?.text).toBe("since this morning");

    // Linear answers: it reaches Slack, and is not sent back to Linear.
    const answer = { id: crypto.randomUUID(), body: "Fixed, rolling out.", issueId: issue?.id };
    const viaLinear = (await owner.sources()).find((each) => each.key === linearKey);
    await deliver(
      vibe,
      viaLinear ?? { id: "" },
      linear.signed({
        action: "create",
        type: "Comment",
        data: answer,
        actor: linear.person("Grace"),
      }),
    );
    await eventually(vibe, () => expect(slack.posted(slackChannel)).toHaveLength(1));
    expect(slack.posted(slackChannel)[0]).toMatchObject({
      thread: first.event["ts"],
      text: expect.stringContaining("Fixed, rolling out."),
    });
    expect(comments()).toHaveLength(1);

    // And what is written on the vibe reaches both.
    await ada.reply(root?.id ?? "", "thanks, both");
    await eventually(vibe, () => {
      expect(slack.posted(slackChannel)).toHaveLength(2);
      expect(comments()).toHaveLength(2);
    });
    expect(comments()[1]?.body).toBe(`**${handle}** wrote:\n\nthanks, both`);
    const synced = await owner.sync(root?.id ?? "");
    expect(synced.targets.map((target) => [target.platform, target.state]).sort()).toEqual([
      ["linear", "synced"],
      ["slack", "synced"],
    ]);
    expect(channel).not.toBe(support);
  });

  test("a pull request's comments reach a Slack thread, and noSync keeps a reply here", async () => {
    const repository = github.repository("www");
    const prs = vibe.channel("prs");
    const viaGitHub = await entries.add("github", { [repository]: prs }, { token: null });
    const viaSlack = await entries.add("slack", {});
    const { owner } = viaSlack;
    const { client: ada } = await vibe.join();
    const reviews = slack.channel(vibe.name("reviews"));

    const pull = github.pull(repository, 5, { title: "Speed up the export" });
    const about = github.about(repository);
    await deliver(
      vibe,
      viaGitHub.source,
      github.signed("pull_request", { ...about, action: "opened", number: 5, pull_request: pull }),
    );
    const root = (await owner.threads({ channel: prs })).threads[0]?.message;
    await owner.sync(root?.id ?? "", `${viaSlack.key}:${reviews}`);
    await eventually(vibe, () => expect(slack.posted(reviews)).toHaveLength(1));

    await deliver(
      vibe,
      viaGitHub.source,
      github.signed("issue_comment", {
        ...about,
        action: "created",
        issue: { ...github.issue(repository, 5), pull_request: {} },
        comment: { id: 9901, body: "LGTM once CI is green.", user: github.account("grace") },
      }),
    );
    await ada.reply(root?.id ?? "", "for the team only: this needs a load test", { noSync: true });
    await eventually(vibe, () => expect(slack.posted(reviews)).toHaveLength(2));
    await settle(vibe);
    expect(slack.posted(reviews).map((message) => message.text)).toEqual([
      `**octocat via ${viaGitHub.service}:** **Speed up the export**`,
      `**grace via ${viaGitHub.service}:** LGTM once CI is green.`,
    ]);
  });

  test("a delivery to Linear that fails is tried again", async () => {
    const { team, channel } = await mapped();
    const { client: ada } = await vibe.join();
    vibe.platforms.fail(1, { matching: "issueCreate" });
    await ada.post(channel, "opened on the second try");
    const made = () => [...linear.issues.values()].filter((each) => each.teamId === team.id);
    await eventually(vibe, () =>
      expect(
        vibe.platforms.calls.filter((call) => !call.ok && call.what === "issueCreate").length,
      ).toBeGreaterThanOrEqual(1),
    );
    expect(made()).toEqual([]);
    await vibe.pass(2500);
    await eventually(vibe, () => expect(made()).toHaveLength(1));
    // The second try asks for the same issue: the ID was the entry's to give, and it gave it once.
    const asked = vibe.platforms.calls
      .filter((call) => call.what === "issueCreate")
      .map((call) => (call.args["input"] as { id?: string; teamId?: string }) ?? {})
      .filter((input) => input.teamId === team.id);
    expect(asked).toHaveLength(2);
    expect(asked[0]?.id).toBe(asked[1]?.id ?? "");
    expect(asked[0]?.id).toBe(made()[0]?.id ?? "");
  }, 30_000);
});
