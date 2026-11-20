import { afterAll, describe, expect, test } from "bun:test";

import { type Grant, VibeError, type VibeHandle } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
const failing = (work: Promise<unknown>) => work.then(() => "nothing", code);

describe("services", () => {
  // Grants made here are revoked at the end, so a vibe that is tested again
  // and again doesn't collect them. Services made here are removed.
  const grants: string[] = [];
  const services: string[] = [];
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
    const by = await owner();
    for (const id of grants) await by.revokeGrant(id).catch(() => {});
    for (const name of services) await by.deleteService(name).catch(() => {});
  });

  /** Adds a service, and returns a client that acts with its token. */
  async function service(prefix = "svc") {
    const name = vibe.name(prefix);
    const made = await (await owner()).createService({ name, description: "A test service." });
    services.push(name);
    return { name, id: made.service.id, token: made.token, client: vibe.connect(made.token) };
  }

  test("an owner adds a service, and its token acts as the service", async () => {
    const { name, id, token, client } = await service();
    expect(id).toStartWith("vibe:service:s_");
    expect(token).toStartWith("vibe_svc_");

    const me = await client.whoami();
    expect(me.role).toBe("service");
    expect(me.actor).toEqual({ actor: id, handle: name, name, principal: id, profile: null });

    const listed = (await client.services()).find((each) => each.name === name);
    expect(listed).toMatchObject({ id, name, description: "A test service." });
    // The list never holds a secret.
    expect(JSON.stringify(await client.services())).not.toContain("vibe_svc_");
  });

  test("only a team owner adds a service, mints its tokens or removes it", async () => {
    const { name, client } = await service();
    const { client: member } = await vibe.join();

    for (const who of [member, client]) {
      expect(await failing(who.createService({ name: vibe.name() }))).toBe("forbidden");
      expect(await failing(who.createServiceToken(name))).toBe("forbidden");
      expect(await failing(who.deleteService(name))).toBe("forbidden");
    }
    // Anyone on the team can see which services there are.
    expect((await member.services()).some((each) => each.name === name)).toBe(true);
  });

  test("a service starts with reading, writing and syncing everywhere, and no say over grants", async () => {
    const { client } = await service();
    const { client: ada } = await vibe.join();
    const channel = vibe.channel();

    expect((await client.whoami()).can?.["*"]).toEqual(["read", "post", "react", "label", "sync"]);
    const root = await ada.post(channel, "is the deploy done?");
    const reply = await client.reply(root.id, "yes", { labels: { state: "done" } });
    await client.react(root.id, "eyes");
    expect((await ada.thread(root.id)).replies.map((each) => each.id)).toEqual([reply.id]);

    expect(await failing(client.grants())).toBe("forbidden");
    expect(await failing(client.createChannel(vibe.channel(), { private: true }))).toBe(
      "forbidden",
    );
    expect(await client.explain(channel)).toMatchObject({
      role: "service",
      pattern: "*",
      can: ["read", "post", "react", "label", "sync"],
    });
  });

  test("a grant names one service, or every service, and the closest one decides", async () => {
    const by = await owner();
    const ci = await service("ci");
    const other = await service("other");
    const area = vibe.channel("deploys");
    const channel = `${area}/www`;

    keep(
      await by.createGrant({
        principals: [{ kind: "service", name: ci.name }],
        can: { [`${area}/`]: "all" },
      }),
    );
    keep(
      await by.createGrant({ principals: [{ kind: "everyone" }], can: { [`${area}/`]: "none" } }),
    );

    const root = await ci.client.post(channel, "deployed a1b2c3");
    expect((await ci.client.thread(root.id)).message.text).toBe("deployed a1b2c3");
    expect(await failing(other.client.thread(root.id))).toBe("message_not_found");
    expect(await failing(other.client.post(channel, "me too"))).toBe("forbidden");

    // Every service may read there now. The one named still gets everything.
    const all = keep(
      await by.createGrant({
        principals: [{ kind: "all-services" }],
        can: { [`${area}/`]: ["read"] },
      }),
    );
    expect(all.principals).toEqual([{ kind: "all-services" }]);
    expect((await other.client.thread(root.id)).message.id).toBe(root.id);
    expect(await failing(other.client.reply(root.id, "me too"))).toBe("forbidden");
    await ci.client.reply(root.id, "and verified");

    expect(await by.explain(channel, { service: other.name })).toMatchObject({
      principal: { id: other.id, handle: other.name },
      role: "service",
      pattern: `${area}/`,
      grants: [all.id],
      can: ["read"],
    });
    const listed = (await by.grants()).find((grant) => grant.id === grants[0]);
    expect(listed?.principals).toEqual([{ kind: "service", id: ci.id, name: ci.name }]);
    // A person is not a service: what names every service names no one else.
    const { client: member } = await vibe.join();
    expect(await failing(member.thread(root.id))).toBe("message_not_found");
  });

  test("a profile of a service works like a profile of a person", async () => {
    const { name, id, client } = await service("ci");
    const { handle, client: ada } = await vibe.join();
    const channel = vibe.channel();
    const deployer = client.as("deployer");

    const me = await deployer.whoami();
    expect(me.actor).toMatchObject({
      actor: `${id}+deployer`,
      handle: `${name}/deployer`,
      principal: id,
      profile: "deployer",
    });
    expect(me.role).toBe("service");

    const root = await deployer.post(channel, `@${handle} the deploy is out`);
    expect(root.by.handle).toBe(`${name}/deployer`);
    expect(root.mentions.map((mention) => mention.handle)).toEqual([handle]);
    const plain = await client.reply(root.id, "noted");

    // The service's name covers its profiles, and people mention either.
    const by = async (who: string) =>
      (await ada.threads({ channel, by: who })).threads.map((thread) => thread.message.id);
    expect(await by(name)).toEqual([root.id]);
    expect(await by(`${name}/deployer`)).toEqual([root.id]);
    const ping = await ada.reply(root.id, `thanks @${name}/deployer and @${name}`);
    expect(ping.mentions.map((mention) => mention.handle)).toEqual([`${name}/deployer`, name]);
    expect(ping.unresolved).toEqual([]);

    // A profile changes only what it wrote. The service itself, what any of them did.
    expect(await failing(deployer.edit(plain.id, "mine now"))).toBe("forbidden");
    expect((await client.edit(root.id, "the deploy is out"))?.text).toBe("the deploy is out");
  });

  test("a service's name is a handle: one that is taken is refused, even after its service is gone", async () => {
    const by = await owner();
    const { name } = await service();
    const { handle } = await vibe.join();

    expect(await failing(by.createService({ name }))).toBe("handle_taken");
    expect(await failing(by.createService({ name: handle }))).toBe("handle_taken");
    expect(await failing(by.createService({ name: "Not A Name" }))).toBe("invalid_handle");

    await by.deleteService(name);
    expect(await failing(by.createService({ name }))).toBe("handle_taken");
  });

  test("a service holds several tokens, and none works once it is removed", async () => {
    const by = await owner();
    const { name, client } = await service();
    const channel = vibe.channel();
    const second = vibe.connect(await by.createServiceToken(name));

    const root = await client.post(channel, "from the first token");
    await second.reply(root.id, "from the second");
    expect((await second.whoami()).actor.handle).toBe(name);

    const removed = await by.deleteService(name);
    expect(removed.name).toBe(name);
    for (const gone of [client, second]) {
      const error = await gone.whoami().catch((e) => e);
      expect([code(error), (error as VibeError).status]).toEqual(["unauthorized", 401]);
    }
    // What it wrote is still there, and still its own.
    const thread = await by.thread(root.id);
    expect([thread.message.by.handle, thread.replies[0]?.by.handle]).toEqual([name, name]);
    expect((await by.services()).some((each) => each.name === name)).toBe(false);
    // It can no longer be named, and removing it again finds nothing.
    expect(
      await failing(
        by.createGrant({ principals: [{ kind: "service", name }], can: { [channel]: "all" } }),
      ),
    ).toBe("service_not_found");
    expect(await failing(by.deleteService(name))).toBe("service_not_found");
  });
});
