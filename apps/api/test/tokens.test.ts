import { afterAll, describe, expect, test } from "bun:test";

import { type Grant, VibeError, type VibeHandle } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
const failing = (work: Promise<unknown>) => work.then(() => "nothing", code);

describe("delegated tokens", () => {
  const grants: string[] = [];
  let admin: VibeHandle | undefined;
  const owner = async () => {
    admin ??= await vibe.owner();
    return admin;
  };
  const keep = (grant: Grant) => {
    grants.push(grant.id);
    return grant;
  };
  afterAll(async () => {
    for (const id of grants) await (await owner()).revokeGrant(id).catch(() => {});
  });

  /** A person, a subtree of their own to work in, and a token for their `fixer` narrowed to it. */
  async function delegated(can?: Record<string, "all" | "none" | ("read" | "post")[]>) {
    const { handle, client: ada } = await vibe.join();
    const area = vibe.channel("dev");
    const minted = await ada
      .as("fixer")
      .createToken({ can: can ?? { [`${area}/`]: ["read", "post"] } });
    return { handle, ada, area, minted, fixer: vibe.connect(minted.token) };
  }

  test("a token minted from your own writes as one profile, with the access you gave it", async () => {
    const { handle, ada, area, minted, fixer } = await delegated();
    expect(minted.token).toStartWith("vibe_dt_");
    expect(minted.profile).toBe("fixer");
    expect(minted.can).toEqual({ [`${area}/`]: ["read", "post"] });
    // An hour, unless asked otherwise.
    const lasts = Date.parse(minted.expiresAt) - Date.now();
    expect(Math.abs(lasts - 3_600_000)).toBeLessThan(vibe.canJump ? 86_400_000 : 60_000);

    const me = await fixer.whoami();
    expect(me.actor).toMatchObject({ handle: `${handle}/fixer`, profile: "fixer" });
    expect(me.can).toEqual({ [`${area}/`]: ["read", "post"] });
    expect(me.narrowed).toEqual({ expiresAt: minted.expiresAt });

    const root = await ada.post(`${area}/bugs`, "checkout times out");
    const reply = await fixer.reply(root.id, "on it");
    expect(reply.by.handle).toBe(`${handle}/fixer`);
    expect((await fixer.threads({ channel: `${area}/` })).threads).toHaveLength(1);
  });

  test("a delegated token is refused outside its can", async () => {
    const { ada, area, fixer } = await delegated();
    const outside = vibe.channel("ops");
    const secret = await ada.post(outside, "the rollout plan");
    const inside = await ada.post(`${area}/bugs`, "a bug");

    // Another channel is closed to it: to post in, to read, and by ID.
    expect(await failing(fixer.post(outside, "hello"))).toBe("forbidden");
    expect(await failing(fixer.thread(secret.id))).toBe("message_not_found");
    expect(await failing(fixer.reply(secret.id, "hi"))).toBe("message_not_found");
    expect((await fixer.threads({ channel: outside })).threads).toEqual([]);
    expect((await fixer.channels()).map((channel) => channel.path)).toEqual([`${area}/bugs`]);

    // Inside its can, only the permissions it names.
    expect(await failing(fixer.label(inside.id, { set: { state: "open" } }))).toBe("forbidden");
    expect(await failing(fixer.react(inside.id, "eyes"))).toBe("forbidden");
    expect(await failing(fixer.post(`${area}/bugs`, "x", { labels: { a: "b" } }))).toBe(
      "forbidden",
    );
    await fixer.post(`${area}/bugs`, "found another");

    // The feed shows it what it may read, and nothing of the rest.
    const start = (await ada.threads()).cursor;
    await ada.post(outside, "not for the fixer");
    const seen = await ada.post(`${area}/bugs`, "for the fixer");
    const page = await fixer.poll({ after: start });
    expect(page.events.map((event) => event.message?.id)).toEqual([seen.id]);
  });

  test("a token only narrows: it gives nothing its minter lacks, then or later", async () => {
    const by = await owner();
    const { handle, client: bob } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const area = vibe.channel("sec");

    // A viewer can't post, so can't hand out posting.
    const asReader = viewer.as("reader");
    expect(await failing(asReader.createToken({ can: { "*": ["read", "post"] } }))).toBe(
      "forbidden",
    );
    expect((await asReader.createToken({ can: { "*": ["read"] } })).can).toEqual({ "*": ["read"] });

    // Bob holds everything in the area for now, and delegates it.
    const hers = keep(
      await by.createGrant({
        principals: [{ kind: "user", handle }],
        can: { [`${area}/`]: "all" },
      }),
    );
    keep(
      await by.createGrant({ principals: [{ kind: "everyone" }], can: { [`${area}/`]: "none" } }),
    );
    const root = await bob.post(`${area}/incidents`, "an incident");
    const agent = vibe.connect(
      (await bob.as("agent").createToken({ can: { [`${area}/`]: "all" } })).token,
    );
    expect((await agent.thread(root.id)).message.id).toBe(root.id);

    // Bob loses the area. The token he minted loses it with him.
    await by.updateGrant(hers.id, { can: { [`${area}/`]: ["read"] } });
    expect(await failing(agent.reply(root.id, "still here"))).toBe("forbidden");
    await by.revokeGrant(hers.id);
    expect(await failing(agent.thread(root.id))).toBe("message_not_found");
    // And he can no longer delegate what he no longer has.
    expect(await failing(bob.as("agent").createToken({ can: { [`${area}/`]: ["read"] } }))).toBe(
      "forbidden",
    );
  });

  test("it is locked to its profile, and changes only what that profile wrote", async () => {
    const { ada, area, minted, fixer } = await delegated();
    const channel = `${area}/bugs`;

    // Naming another profile is refused. Naming its own, or none, is fine.
    expect(await failing(vibe.connect(minted.token).as("someone-else").whoami())).toBe(
      "profile_locked",
    );
    expect((await vibe.connect(minted.token).as("fixer").whoami()).actor.profile).toBe("fixer");
    expect((await vibe.connect(minted.token).as(null).whoami()).actor.profile).toBe("fixer");

    const hers = await ada.post(channel, "written by ada");
    const other = await ada.as("reviewer").post(channel, "written by her reviewer");
    const own = await fixer.post(channel, "written by the fixer");
    expect(await failing(fixer.edit(hers.id, "mine now"))).toBe("forbidden");
    expect(await failing(fixer.delete(other.id))).toBe("forbidden");
    expect((await fixer.edit(own.id, "edited by the fixer"))?.text).toBe("edited by the fixer");
  });

  test("a narrowed caller can't change grants, mint tokens, add services or schedule, whatever its can says", async () => {
    const by = await owner();
    const everything = vibe.connect(
      (await by.as("deputy").createToken({ can: { "*": "all" } })).token,
    );
    const channel = vibe.channel();

    // An owner's token counts as a member's: what only owners do is not passed on.
    const me = await everything.whoami();
    expect(me.role).toBe("member");
    expect(me.can).toEqual({ "*": ["read", "post", "react", "label", "sync", "manage"] });
    const root = await everything.post(channel, "it can still do the work");
    await everything.label(root.id, { set: { state: "open" } });
    // Holding manage at *, it may read the grants. It may not touch them.
    expect((await everything.grants()).length).toBeGreaterThan(0);

    const refused = await Promise.all(
      [
        everything.createGrant({ principals: [{ kind: "everyone" }], can: { [channel]: "none" } }),
        everything.updateGrant("g2", { can: { "*": ["read"] } }),
        everything.revokeGrant("g2"),
        everything.createChannel(vibe.channel(), { private: true }),
        everything.createToken({ profile: "deputy", can: { [channel]: ["read"] } }),
        everything.createService({ name: vibe.name("svc") }),
        everything.schedule(channel, { text: "later", in: "1h" }),
      ].map(failing),
    );
    expect(refused).toEqual(refused.map(() => "forbidden"));
  });

  test("a limit binds what its principal owns, too: messages, schedules, tasks and files", async () => {
    const { ada, area } = await delegated();
    const inside = `${area}/work`;
    const outside = vibe.channel("ops");
    const reader = vibe.connect(
      (await ada.as("fixer").createToken({ can: { [`${area}/`]: ["read"] } })).token,
    );
    const writer = vibe.connect(
      (await ada.as("fixer").createToken({ can: { [`${area}/`]: ["read", "post"] } })).token,
    );
    // The same limit, carried by a handle on her own token and not by a token of its own.
    const carried = ada.as("fixer", { can: { [`${area}/`]: ["read"] } });
    const asFixer = ada.as("fixer");

    // Deleting what you wrote takes nothing of you. Of a limit, it takes `post` there.
    const elsewhere = await asFixer.post(outside, "written by the fixer, outside the limit");
    const within = await asFixer.post(inside, "written by the fixer, inside it");
    for (const limited of [reader, writer, carried]) {
      expect(await failing(limited.delete(elsewhere.id))).toBe("message_not_found");
    }
    for (const limited of [reader, carried]) {
      expect(await failing(limited.delete(within.id))).toBe("forbidden");
    }
    expect((await ada.thread(elsewhere.id)).message.deletedAt).toBeNull();
    expect((await writer.delete(within.id))?.deletedAt).not.toBeNull();

    // Its principal's schedule outside the limit is not there to cancel, or to read.
    const schedule = await asFixer.schedule(outside, { text: "a reminder for later", in: "1h" });
    for (const limited of [reader, writer, carried]) {
      expect(await failing(limited.cancelSchedule(schedule.id))).toBe("schedule_not_found");
    }
    expect((await ada.getSchedule(schedule.id)).state).toBe("pending");
    await ada.cancelSchedule(schedule.id);

    // Owning a task is not enough to change it under a limit that only reads.
    const { task } = await asFixer.tasks.create(inside, "a task of the fixer's");
    const hidden = await asFixer.tasks.create(outside, "a task outside the limit");
    for (const limited of [reader, writer, carried]) {
      expect(await failing(limited.tasks.cancel(task.id, "no longer needed"))).toBe("forbidden");
      expect(await failing(limited.tasks.cancel(hidden.task.id, "nor this"))).toBe(
        "task_not_found",
      );
    }
    expect((await ada.tasks.get(task.id)).task.state).toBe("ready");

    // A plan made under a key comes back only to a caller that could have made it.
    const plan = [{ text: "step one" }, { text: "step two" }];
    const key = vibe.name("plan");
    const made = await asFixer.tasks.createMany(outside, plan, { idempotencyKey: key });
    for (const limited of [reader, writer, carried]) {
      expect(await failing(limited.tasks.createMany(outside, plan, { idempotencyKey: key }))).toBe(
        "forbidden",
      );
    }
    const again = await asFixer.tasks.createMany(outside, plan, { idempotencyKey: key });
    expect(again.map((each) => each.task.id)).toEqual(made.map((each) => each.task.id));

    // It posts the files it uploaded itself. Not her uploads, which it could then read.
    const hers = await ada.upload({ name: "payroll.csv", data: "not for the agent" });
    expect(await failing(writer.post(inside, "look", { attachments: [hers.id] }))).toBe(
      "attachment_not_found",
    );
    expect(await failing(writer.download(hers.id))).toBe("attachment_not_found");
    const own = await writer.upload({ name: "trace.txt", data: "what the agent found" });
    const posted = await writer.post(inside, "trace attached", { attachments: [own.id] });
    expect(posted.attachments.map((file) => file.id)).toEqual([own.id]);
    expect(await (await writer.download(own.id)).response.text()).toBe("what the agent found");
    // She can still post her own.
    await ada.post(outside, "payroll", { attachments: [hers.id] });
  });

  test("it stops working when it expires", async () => {
    const { ada, area } = await delegated();
    const short = await ada.as("fixer").createToken({ can: { [`${area}/`]: ["read"] }, ttl: "2s" });
    const fixer = vibe.connect(short.token);
    expect((await fixer.whoami()).actor.profile).toBe("fixer");

    await vibe.pass(2500);
    const error = await fixer.whoami().catch((e) => e);
    expect([code(error), (error as VibeError).status]).toEqual(["unauthorized", 401]);
    expect((error as VibeError).message).toContain("expired");

    for (const ttl of ["0.5s", "25h"]) {
      expect(
        await failing(ada.as("fixer").createToken({ can: { [`${area}/`]: ["read"] }, ttl })),
      ).toBe("invalid_ttl");
    }
  });

  test("a service delegates its own access the same way", async () => {
    const by = await owner();
    const name = vibe.name("svc");
    const ci = vibe.connect((await by.createService({ name })).token);
    const channel = vibe.channel("deploys");

    const minted = await ci.createToken({
      profile: "runner",
      can: { [channel]: ["read", "post"] },
    });
    const runner = vibe.connect(minted.token);
    expect((await runner.whoami()).actor.handle).toBe(`${name}/runner`);
    expect((await runner.post(channel, "deployed")).by.handle).toBe(`${name}/runner`);
    // The service has no manage, so it has none to pass on.
    expect(await failing(ci.createToken({ profile: "runner", can: { [channel]: "all" } }))).toBe(
      "forbidden",
    );

    // Its tokens die with it.
    await by.deleteService(name);
    expect(await failing(runner.whoami())).toBe("unauthorized");
  });

  test("a handle carries a limit of its own, and Vibe holds it to that on every call", async () => {
    const { ada, area } = await delegated();
    const outside = vibe.channel("ops");
    const secret = await ada.post(outside, "the rollout plan");
    const inside = await ada.post(`${area}/bugs`, "a bug");

    const fixer = ada.as("fixer", { can: { [`${area}/`]: ["read", "post", "label"] } });
    const me = await fixer.whoami();
    expect(me.can).toEqual({ [`${area}/`]: ["read", "post", "label"] });
    expect(me.narrowed).toEqual({ expiresAt: null });
    await fixer.reply(inside.id, "on it");
    expect(await failing(fixer.thread(secret.id))).toBe("message_not_found");
    expect(await failing(fixer.post(outside, "hello"))).toBe("forbidden");
    expect(await failing(fixer.createToken({ can: { [`${area}/`]: ["read"] } }))).toBe("forbidden");

    // Its own as() only narrows it further, and can't shake the limit off.
    const reader = fixer.as("reader", { can: { [`${area}/`]: ["read"], [outside]: "all" } });
    expect((await reader.whoami()).can).toEqual({ [`${area}/`]: ["read"] });
    expect(await failing(reader.reply(inside.id, "me too"))).toBe("forbidden");
    expect((await fixer.as("other").whoami()).can).toEqual({
      [`${area}/`]: ["read", "post", "label"],
    });

    // A delegated token narrows further the same way, and a limit that isn't one is refused.
    const minted = await ada.as("fixer").createToken({ can: { [`${area}/`]: ["read", "post"] } });
    const less = vibe.connect(minted.token).as("fixer", { can: { [`${area}/`]: ["read"] } });
    expect((await less.whoami()).can).toEqual({ [`${area}/`]: ["read"] });
    expect(await failing(ada.as("x", { can: { dev: "everything" as "all" } }).whoami())).toBe(
      "invalid_can",
    );
  });
});
