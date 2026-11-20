import { describe, expect, test } from "bun:test";

import { type DeviceLogin, deviceLogin, VibeError } from "@vibe/sdk";

import type { StubAccount } from "./github-stub.ts";
import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));

/** Adds a person the way an operator does, saying which GitHub account is theirs. */
async function operatorAdds(on: typeof vibe, handle: string, github?: string) {
  const response = await on.fetch(`${on.url}/v1/admin/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${on.adminSecret}`, "content-type": "application/json" },
    body: JSON.stringify(github === undefined ? { handle } : { handle, github }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: string; user: { id: string; handle: string } };
}

/**
 * Signs in through the device flow as the SDK and the CLI do, with a person
 * at the stubbed GitHub who does `inBrowser` once they have the code.
 */
async function signIn(on: typeof vibe, inBrowser: (code: DeviceLogin) => void) {
  const waits: number[] = [];
  const signed = await deviceLogin({
    url: on.url,
    fetch: on.fetch,
    onCode: inBrowser,
    // No one waits in a test. What the device would have waited is kept.
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { ...signed, waits };
}

let accounts = 1000;
const account = (login: string): StubAccount => ({ id: ++accounts, login, name: `The ${login}` });

// Against a running Vibe there is no stub to stand in for GitHub.
const stubbed = test.skipIf(vibe.github === null);

describe("logging in through GitHub", () => {
  test.skipIf(vibe.github !== null)(
    "a Vibe with no GitHub app says so, and takes a token as before",
    async () => {
      const error = await deviceLogin({ url: vibe.url, onCode: () => {} }).catch((e) => e);
      expect([code(error), (error as VibeError).status]).toEqual(["login_unavailable", 404]);
      expect((error as VibeError).hint).toContain("--token");

      const { client } = await vibe.join();
      expect((await client.whoami()).actor.handle).toStartWith("u-");
    },
  );

  stubbed(
    "the device flow issues a Vibe token for whoever the GitHub account belongs to",
    async () => {
      const github = vibe.github;
      if (!github) throw new Error("This test needs the stub.");
      const handle = vibe.name("ada");
      const ada = account(`${handle}-gh`);
      const added = await operatorAdds(vibe, handle, ada.login.toUpperCase());
      const before = github.requests.length;

      let shown: DeviceLogin | undefined;
      const signed = await signIn(vibe, (code) => {
        shown = code;
        github.approve(code.userCode, ada);
      });

      expect(shown?.userCode).toMatch(/^STUB-\d{4}$/);
      expect(shown?.verificationUri).toBe("https://github.com/login/device");
      // The person the operator named: found by the login the operator gave, however it was capitalized.
      expect(signed.user).toMatchObject({ id: added.user.id, handle });
      expect(signed.created).toBe(false);
      expect(signed.token).toStartWith("vibe_sk_");
      expect(signed.token).not.toBe(added.token);
      // It waited as long as GitHub asked before asking.
      expect(signed.waits).toEqual([5000]);

      // The token is Vibe's own, and theirs. The one the operator handed out still works.
      for (const token of [signed.token, added.token]) {
        expect((await vibe.connect(token).whoami()).actor.handle).toBe(handle);
      }

      // What went to GitHub: the app's client ID, and no scope asked for. The
      // token GitHub gave was used to ask who signed in, and only for that.
      const sent = github.requests.slice(before);
      expect(sent.map((request) => new URL(request.url).pathname)).toEqual([
        "/login/device/code",
        "/login/oauth/access_token",
        "/user",
      ]);
      expect(sent[0]?.body).toBe(`client_id=${encodeURIComponent(github.clientId)}`);
      expect(sent[2]?.authorization).toStartWith("Bearer gho_stub_");
      expect(JSON.stringify(signed)).not.toContain("gho_stub_");
    },
  );

  stubbed(
    "the account is known by its number from then on, whatever it is renamed to",
    async () => {
      const github = vibe.github;
      if (!github) throw new Error("This test needs the stub.");
      const handle = vibe.name("bob");
      const bob = account(`${handle}-gh`);
      const added = await operatorAdds(vibe, handle, bob.login);
      await signIn(vibe, (code) => github.approve(code.userCode, bob));

      // He renames his account at GitHub, and someone else takes the login he
      // left. Vibe has not heard of the rename, and still they are no one
      // here: the account was his by its number, not its name.
      const squatter = account(bob.login);
      const error = await signIn(vibe, (code) => github.approve(code.userCode, squatter)).catch(
        (e) => e,
      );
      expect(code(error)).toBe("signup_closed");

      // Under his new name he is still himself.
      const renamed = { ...bob, login: `${handle}-renamed` };
      const again = await signIn(vibe, (code) => github.approve(code.userCode, renamed));
      expect([again.user.id, again.created]).toEqual([added.user.id, false]);
    },
  );

  stubbed(
    "an account that is no one's is refused, unless the operator allows sign-up",
    async () => {
      const github = vibe.github;
      if (!github) throw new Error("This test needs the stub.");
      const stranger = account(vibe.name("stranger"));
      const error = await signIn(vibe, (code) => github.approve(code.userCode, stranger)).catch(
        (e) => e,
      );
      expect([code(error), (error as VibeError).status]).toEqual(["signup_closed", 403]);
      expect((error as VibeError).hint).toContain(`--github ${stranger.login}`);

      // On a Vibe whose operator allows it, a first sign-in adds them, under their login.
      const open = harness({ signup: true });
      const hub = open.github;
      if (!hub) throw new Error("This test needs the stub.");
      const first = await signIn(open, (code) => hub.approve(code.userCode, stranger));
      expect(first.created).toBe(true);
      // The first person on a team owns it. Whoever follows is a member.
      expect(first.user).toMatchObject({
        handle: stranger.login,
        name: stranger.name,
        role: "owner",
      });
      const second = await signIn(open, (code) => hub.approve(code.userCode, stranger));
      expect([second.created, second.user.id]).toEqual([false, first.user.id]);
      const next = account(open.name("next"));
      const member = await signIn(open, (code) => hub.approve(code.userCode, next));
      expect([member.created, member.user.role]).toEqual([true, "member"]);

      // A handle someone already has is not taken over by whoever has that login at GitHub.
      const { handle } = await open.join();
      const lookalike = await signIn(open, (code) =>
        hub.approve(code.userCode, account(handle)),
      ).catch((e) => e);
      expect([code(lookalike), (lookalike as VibeError).status]).toEqual(["handle_taken", 409]);
      expect((lookalike as VibeError).hint).toContain("vibe admin user link");
    },
  );

  stubbed("an operator links someone who is already here to their GitHub account", async () => {
    const github = vibe.github;
    if (!github) throw new Error("This test needs the stub.");
    const { handle } = await vibe.join();
    const carol = account(vibe.name("carol-gh"));
    const link = (body: unknown, secret = vibe.adminSecret) =>
      vibe.fetch(`${vibe.url}/v1/admin/users/${handle}/github`, {
        method: "PUT",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await link({ github: carol.login }, "not-the-secret")).status).toBe(403);
    expect((await link({ github: "not a login" })).status).toBe(400);
    expect((await link({ github: carol.login })).status).toBe(200);
    // One account is one person's. Linking it again to them is fine, and to another is not.
    expect((await link({ github: carol.login })).status).toBe(200);
    const other = await vibe.join();
    const clash = await vibe.fetch(`${vibe.url}/v1/admin/users/${other.handle}/github`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${vibe.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ github: carol.login }),
    });
    expect([clash.status, ((await clash.json()) as { code: string }).code]).toEqual([
      409,
      "github_taken",
    ]);
    const signed = await signIn(vibe, (code) => github.approve(code.userCode, carol));
    expect(signed.user.handle).toBe(handle);
  });

  stubbed("a sign-in that is refused, runs out or is hurried ends as it should", async () => {
    const github = vibe.github;
    if (!github) throw new Error("This test needs the stub.");
    const handle = vibe.name("dan");
    const dan = account(`${handle}-gh`);
    await operatorAdds(vibe, handle, dan.login);

    const denied = await signIn(vibe, (code) => github.deny(code.userCode)).catch((e) => e);
    expect([code(denied), (denied as VibeError).status]).toEqual(["login_denied", 403]);
    const expired = await signIn(vibe, (code) => github.expire(code.userCode)).catch((e) => e);
    expect([code(expired), (expired as VibeError).status]).toEqual(["login_expired", 400]);

    // Asked too often, the device leaves it for as long as GitHub says from then on.
    const hurried = await signIn(vibe, (code) => {
      github.slowDown(code.userCode, 1);
      github.approve(code.userCode, dan);
    });
    expect(hurried.user.handle).toBe(handle);
    expect(hurried.waits).toEqual([5000, 10_000]);

    // A code no one was given, and a code that was already used, are both spent.
    const poll = (deviceCode: string) =>
      vibe.fetch(`${vibe.url}/v1/login/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode }),
      });
    const made = await vibe.fetch(`${vibe.url}/v1/login/device`, { method: "POST" });
    const { deviceCode, userCode } = (await made.json()) as DeviceLogin;
    expect(await (await poll(deviceCode)).json()).toEqual({ status: "pending", interval: null });
    github.approve(userCode, dan);
    expect(((await (await poll(deviceCode)).json()) as { status: string }).status).toBe("complete");
    for (const spent of [deviceCode, "made-up"]) {
      const response = await poll(spent);
      expect([response.status, ((await response.json()) as { code: string }).code]).toEqual([
        400,
        "login_expired",
      ]);
    }
  });
});
