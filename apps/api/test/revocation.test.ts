import { describe, expect, test } from "bun:test";

import { type HeldToken, signIn, VibeError } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
const failing = (work: Promise<unknown>) => work.then(() => "nothing", code);

/** An operator's request about a person's tokens. */
async function asOperator(method: string, path: string) {
  const response = await vibe.fetch(`${vibe.url}/v1/admin/users/${path}`, {
    method,
    headers: { authorization: `Bearer ${vibe.adminSecret}` },
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Another token for someone, minted the way an operator does, to tell from their first. */
async function another(handle: string): Promise<string> {
  const { status, body } = await asOperator("POST", `${handle}/tokens`);
  expect(status).toBe(201);
  return String(body["token"]);
}

/** What a browser would hold after signing in with a token: its cookie, to send back. */
async function browserWith(token: string): Promise<string> {
  const origin = new URL(vibe.url).origin;
  const response = await vibe.fetch(`${vibe.url}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, "user-agent": "A browser under test" },
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(201);
  return (response.headers.get("set-cookie") ?? "").split("; ")[0] ?? "";
}

const whoamiWith = (cookie: string) =>
  vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie } }).then((response) => response.status);

describe("the tokens you hold", () => {
  test("are listed by what they are for, the one in use marked, and never a secret", async () => {
    const { handle, token, client } = await vibe.join();
    const second = await another(handle);
    const minted = await client
      .as("fixer")
      .createToken({ can: { "dev/": ["read", "post"] }, ttl: "2h" });

    const listed = await client.tokens();
    expect(listed.map((each) => [each.kind, each.label, each.current])).toEqual([
      ["user", "initial", true],
      ["user", null, false],
      ["delegated", null, false],
    ]);
    const [first, , delegated] = listed;
    expect(first?.id).toStartWith("tok_");
    expect(first?.expiresAt).toBeNull();
    expect(delegated).toMatchObject({
      id: minted.id,
      expiresAt: minted.expiresAt,
      revokedAt: null,
      delegated: {
        vibe: { name: "general" },
        profile: "fixer",
        can: { "dev/": ["read", "post"] },
        // What it ends with: the token it was minted with.
        mintedWith: first?.id,
      },
    });
    const said = JSON.stringify(listed);
    for (const secret of [token, second, minted.token]) expect(said).not.toContain(secret);
    expect(said).not.toMatch(/vibe_(sk|dt|svc)_/);

    // The same list, whichever of your tokens asks, with its own marked.
    const fromSecond = await vibe.connect(second).tokens();
    expect(fromSecond.map((each) => each.current)).toEqual([false, true, false]);
  });

  test("one you revoke stops working at once, and the rest carry on", async () => {
    const { handle, token, client } = await vibe.join();
    const lost = await another(handle);
    const laptop = vibe.connect(lost);
    expect((await laptop.whoami()).actor.handle).toBe(handle);
    const held = (await client.tokens()).find((each) => !each.current);
    if (!held) throw new Error("The second token is not listed.");

    const revoked = await client.revokeToken(held.id);
    expect(revoked.id).toBe(held.id);
    expect(revoked.revokedAt).not.toBeNull();
    expect(await failing(laptop.whoami())).toBe("unauthorized");
    expect((await vibe.connect(token).whoami()).actor.handle).toBe(handle);
    expect((await client.tokens()).map((each) => each.id)).not.toContain(held.id);

    // A retry is answered as the first try was.
    expect((await client.revokeToken(held.id)).revokedAt).toBe(revoked.revokedAt);
  });

  test("a token gives itself up, and that was its last request", async () => {
    const { handle, client } = await vibe.join();
    const spare = vibe.connect(await another(handle));
    const own = (await spare.tokens()).find((each) => each.current);
    expect((await spare.revokeToken(own?.id ?? "")).current).toBe(true);
    expect(await failing(spare.whoami())).toBe("unauthorized");
    expect((await client.whoami()).actor.handle).toBe(handle);
  });

  test("nobody revokes another's, or learns it is there", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join("owner");
    const [adas] = await ada.tokens();
    const minted = await ada.as("fixer").createToken({ can: { "*": "all" } });

    for (const id of [adas?.id ?? "", minted.id, "tok_none", "dt_none", "nonsense"]) {
      expect(await failing(bob.revokeToken(id))).toBe("token_not_found");
    }
    expect((await ada.whoami()).role).toBe("member");
    expect((await vibe.connect(minted.token).whoami()).actor.profile).toBe("fixer");
  });

  test("a narrowed handle, and a delegated token, see and revoke none", async () => {
    const { client } = await vibe.join();
    const [own] = await client.tokens();
    const minted = await client.as("fixer").createToken({ can: { "*": "all" } });
    const fixer = vibe.connect(minted.token);
    const narrowed = client.as(null, { can: { "*": "all" } });

    for (const held of [fixer, narrowed]) {
      expect(await failing(held.tokens())).toBe("forbidden");
      expect(await failing(held.revokeToken(own?.id ?? ""))).toBe("forbidden");
      expect(await failing(held.revokeToken(minted.id))).toBe("forbidden");
      expect(await failing(held.sessions())).toBe("forbidden");
    }
    expect((await fixer.whoami()).actor.profile).toBe("fixer");
  });
});

describe("delegated tokens and revocation", () => {
  test("a delegated token stops working when the token that minted it is revoked", async () => {
    const { handle, client } = await vibe.join();
    const leaked = vibe.connect(await another(handle));
    const channel = vibe.channel("dev");
    const fromLeaked = await leaked.as("fixer").createToken({ can: { "*": "all" } });
    const fromFirst = await client.as("fixer").createToken({ can: { "*": "all" } });
    const agent = vibe.connect(fromLeaked.token);
    await agent.post(channel, "working");

    const held = (await client.tokens()).find((each) => each.kind === "user" && !each.current);
    await client.revokeToken(held?.id ?? "");

    // What the leaked token minted goes with it: to read, and to write.
    expect(await failing(agent.whoami())).toBe("unauthorized");
    expect(await failing(agent.post(channel, "still here?"))).toBe("unauthorized");
    expect((await client.threads({ channel })).threads).toHaveLength(1);
    // What another token minted is untouched.
    expect((await vibe.connect(fromFirst.token).whoami()).actor.profile).toBe("fixer");
    const left = (await client.tokens()).map((each) => each.id);
    expect(left).toContain(fromFirst.id);
    expect(left).not.toContain(fromLeaked.id);
  });

  test("a delegated token is revoked by name, by whoever it was minted from", async () => {
    const { client } = await vibe.join();
    const minted = await client.as("fixer").createToken({ can: { "*": "all" } });
    const other = await client.as("fixer").createToken({ can: { "*": "all" } });

    const revoked = await client.revokeToken(minted.id);
    expect(revoked).toMatchObject({ id: minted.id, kind: "delegated" });
    expect(revoked.revokedAt).not.toBeNull();
    expect(await failing(vibe.connect(minted.token).whoami())).toBe("unauthorized");
    expect((await vibe.connect(other.token).whoami()).actor.profile).toBe("fixer");
    expect((await client.revokeToken(minted.id)).revokedAt).toBe(revoked.revokedAt);
  });

  test("a browser session ends with the token that opened it, and so does what it minted", async () => {
    const { handle, client } = await vibe.join();
    const leaked = await another(handle);
    const cookie = await browserWith(leaked);
    const origin = new URL(vibe.url).origin;
    // From the page, a delegated token is minted with the session.
    const response = await vibe.fetch(`${vibe.url}/v1/vibes/general/tokens`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ profile: "fixer", can: { "*": "all" } }),
    });
    expect(response.status).toBe(201);
    const minted = (await response.json()) as { token: string };
    // A session of the same person that the token had no part in.
    const other = await browserWith(await another(handle));
    expect(await whoamiWith(cookie)).toBe(200);

    const held = (await client.tokens()).find((each) => each.kind === "user" && !each.current);
    await client.revokeToken(held?.id ?? "");

    expect(await whoamiWith(cookie)).toBe(401);
    expect(await failing(vibe.connect(minted.token).whoami())).toBe("unauthorized");
    expect(await whoamiWith(other)).toBe(200);
    expect((await client.sessions()).map((each) => each.openedWith)).not.toContain(held?.id);
  });
});

describe("a service's tokens", () => {
  test("are a team owner's to list and revoke, one at a time", async () => {
    const owner = await vibe.owner();
    const { client: member } = await vibe.join();
    const name = vibe.name("ci");
    const made = await owner.createService({ name });
    const second = await owner.createServiceToken(name, { label: "runner" });
    const job = await vibe
      .connect(made.token)
      .as("job")
      .createToken({ can: { "*": ["read"] } });

    const listed = await owner.serviceTokens(name);
    expect(listed.map((each) => [each.kind, each.label])).toEqual([
      ["service", "initial"],
      ["service", "runner"],
      ["delegated", null],
    ]);
    const said = JSON.stringify(listed);
    for (const secret of [made.token, second, job.token]) expect(said).not.toContain(secret);
    expect(await failing(member.serviceTokens(name))).toBe("forbidden");
    expect(await failing(member.revokeServiceToken(name, listed[0]?.id ?? ""))).toBe("forbidden");
    expect(await failing(owner.serviceTokens(vibe.name("none")))).toBe("service_not_found");
    // A token is revoked through the service it belongs to, and no other way.
    const [mine] = await owner.tokens();
    expect(await failing(owner.revokeServiceToken(name, mine?.id ?? ""))).toBe("token_not_found");
    expect(await failing(owner.revokeToken(listed[0]?.id ?? ""))).toBe("token_not_found");

    await owner.revokeServiceToken(name, listed[0]?.id ?? "");
    expect(await failing(vibe.connect(made.token).whoami())).toBe("unauthorized");
    // The delegated token it minted goes with it. The service's other token stays.
    expect(await failing(vibe.connect(job.token).whoami())).toBe("unauthorized");
    const runner = vibe.connect(second);
    expect((await runner.whoami()).actor.handle).toBe(name);
    // A service sees its own, and may give one up.
    const own: HeldToken[] = await runner.tokens();
    expect(own.map((each) => [each.label, each.current])).toEqual([["runner", true]]);
  });
});

describe("the operator and a person's tokens", () => {
  test("lists them and revokes one, for a token lost with the machine that held it", async () => {
    const { handle, token, client } = await vibe.join();
    const lost = await another(handle);

    const listed = await asOperator("GET", `${handle}/tokens`);
    expect(listed.status).toBe(200);
    const tokens = listed.body["tokens"] as HeldToken[];
    expect(tokens.map((each) => [each.kind, each.label, each.current])).toEqual([
      ["user", "initial", false],
      ["user", null, false],
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(lost);

    const revoked = await asOperator("DELETE", `${handle}/tokens/${tokens[1]?.id}`);
    expect(revoked.status).toBe(200);
    expect(await failing(vibe.connect(lost).whoami())).toBe("unauthorized");
    expect((await vibe.connect(token).whoami()).actor.handle).toBe(handle);
    expect((await client.tokens()).map((each) => each.id)).toEqual([tokens[0]?.id ?? ""]);

    // Someone else's token is not theirs to lose.
    const { handle: other } = await vibe.join();
    const wrong = await asOperator("DELETE", `${other}/tokens/${tokens[0]?.id}`);
    expect([wrong.status, wrong.body["code"]]).toEqual([404, "token_not_found"]);
    const nobody = await asOperator("GET", `${vibe.name("nobody")}/tokens`);
    expect([nobody.status, nobody.body["code"]]).toEqual([404, "user_not_found"]);
    // And it takes the operator's secret, as every operator's route does.
    const open = await vibe.fetch(`${vibe.url}/v1/admin/users/${handle}/tokens`);
    expect(open.status).toBe(403);
  });
});

describe("signing in with a revoked token", () => {
  test("opens no session", async () => {
    const { handle, client } = await vibe.join();
    const lost = await another(handle);
    const held = (await client.tokens()).find((each) => !each.current);
    await client.revokeToken(held?.id ?? "");
    expect(await failing(signIn(lost, { url: vibe.url, fetch: vibe.fetch }))).toBe("unauthorized");
  });
});
