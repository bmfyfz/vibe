import { describe, expect, test } from "bun:test";

import { signIn, signInWays, signInWithGitHub, VibeError } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const origin = new URL(vibe.url).origin;
// Over HTTPS the cookie carries the prefix that makes it the host's alone.
const COOKIE = origin.startsWith("https:") ? "__Host-vibe_session" : "vibe_session";

/** What a browser would do with a response's `Set-Cookie`: keep the pair, to send back. */
function cookieOf(response: Response): { pair: string; attributes: string[] } {
  const [pair = "", ...attributes] = (response.headers.get("set-cookie") ?? "").split("; ");
  return { pair, attributes };
}

/** Signs in with a token, as the page does, and returns the cookie a browser would hold. */
async function signedIn(token: string, base = vibe.url) {
  const response = await vibe.fetch(`${base}/v1/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(base).origin },
    body: JSON.stringify({ token }),
  });
  return { response, ...cookieOf(response) };
}

/** A request as a page of the Vibe's own would make it, with the browser's cookie. */
const asBrowser = (cookie: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { cookie, origin, ...(init.headers as Record<string, string> | undefined) },
});

describe("signing in from a browser", () => {
  test("a token is traded for a session in a cookie that scripts can't read", async () => {
    const { handle, token } = await vibe.join();
    const { response, pair, attributes } = await signedIn(token);

    expect(response.status).toBe(201);
    const body = (await response.json()) as { user: { handle: string }; expiresAt: string };
    expect(body.user.handle).toBe(handle);
    // About thirty days from now.
    const lasts = Date.parse(body.expiresAt) - vibe.now();
    expect(lasts).toBeGreaterThan(29 * 86_400_000);
    expect(lasts).toBeLessThanOrEqual(30 * 86_400_000);

    expect(pair).toStartWith(`${COOKIE}=vibe_ses_`);
    expect(attributes).toContain("HttpOnly");
    expect(attributes).toContain("SameSite=Strict");
    expect(attributes).toContain("Path=/");
    // Neither the token nor the session's secret is handed to the page.
    const said = JSON.stringify(body);
    expect(said).not.toContain(token);
    expect(said).not.toContain(pair.split("=")[1] ?? "?");

    // The cookie alone says who is asking: no token is sent.
    const whoami = await vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie: pair } });
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({ actor: { handle, profile: null } });
  });

  test.skipIf(!vibe.canJump)(
    "over HTTPS the cookie is the host's alone, and never sent in the clear",
    async () => {
      const { token } = await vibe.join();
      const { response, pair, attributes } = await signedIn(token, "https://vibe.test");
      expect(response.status).toBe(201);
      expect(pair).toStartWith("__Host-vibe_session=");
      expect(attributes).toContain("Secure");
      expect(attributes).toContain("HttpOnly");
      // The plain name is not taken over HTTPS, where another site of the domain could have set it.
      const plain = `vibe_session=${pair.split("=")[1]}`;
      const refused = await vibe.fetch("https://vibe.test/v1/whoami", {
        headers: { cookie: plain },
      });
      expect(refused.status).toBe(401);
      const taken = await vibe.fetch("https://vibe.test/v1/whoami", { headers: { cookie: pair } });
      expect(taken.status).toBe(200);
    },
  );

  test("only a person's own token signs in", async () => {
    const { client: owner } = await vibe.join("owner");
    const service = await owner.createService({ name: vibe.name("svc") });
    const delegated = await owner.as("agent").createToken({ can: { "*": "all" } });

    expect((await signedIn(service.token)).response.status).toBe(403);
    expect((await signedIn(delegated.token)).response.status).toBe(403);
    const unknown = await signedIn("vibe_sk_0000000000000000000000000000000000000000");
    expect(unknown.response.status).toBe(401);
    expect(unknown.response.headers.get("set-cookie")).toBeNull();
    expect((await signedIn("not a token at all")).response.status).toBe(401);
  });

  test("a write that rides on the cookie must come from the Vibe's own pages", async () => {
    const { token, client } = await vibe.join();
    const { pair } = await signedIn(token);
    const channel = vibe.channel();
    const post = (headers: Record<string, string>) =>
      vibe.fetch(`${vibe.url}/v1/vibes/general/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: pair, ...headers },
        body: JSON.stringify({ channel, text: "hello from a page" }),
      });

    // Another site's page, and a request that doesn't say where it is from.
    const foreign = await post({ origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: "forbidden" });
    expect((await post({})).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await client.threads({ channel })).threads).toEqual([]);

    expect((await post({ origin })).status).toBe(201);
    expect((await client.threads({ channel })).threads).toHaveLength(1);
    // Reads need no such proof: another site can cause one, and can't see the answer.
    const read = await vibe.fetch(`${vibe.url}/v1/vibes/general/threads?channel=${channel}`, {
      headers: { cookie: pair },
    });
    expect(read.status).toBe(200);
    // A token is something its sender had to have. With one, the cookie and where it came from don't matter.
    const withToken = await post({
      authorization: `Bearer ${token}`,
      origin: "https://evil.example",
    });
    expect(withToken.status).toBe(201);
    // Another site can't sign the browser in as someone else, either.
    const planted = await vibe.fetch(`${vibe.url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ token }),
    });
    expect(planted.status).toBe(403);
    expect(planted.headers.get("set-cookie")).toBeNull();
  });

  test("signing out ends the session, wherever its cookie still is", async () => {
    const { token } = await vibe.join();
    const { pair } = await signedIn(token);
    const other = await signedIn(token);

    // Not from another site's page.
    const forged = await vibe.fetch(`${vibe.url}/v1/session`, {
      method: "DELETE",
      headers: { cookie: pair, origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
    expect((await vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie: pair } })).status).toBe(
      200,
    );

    const out = await vibe.fetch(`${vibe.url}/v1/session`, asBrowser(pair, { method: "DELETE" }));
    expect(out.status).toBe(200);
    expect(cookieOf(out).pair).toBe(`${COOKIE}=`);
    expect(cookieOf(out).attributes).toContain("Max-Age=0");
    // A copy of the cookie someone kept is good for nothing now.
    const replayed = await vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie: pair } });
    expect(replayed.status).toBe(401);
    // Each sign-in is a session of its own: the other browser is still in.
    const still = await vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie: other.pair } });
    expect(still.status).toBe(200);
  });

  test.skipIf(!vibe.canJump)("a session ends by itself after thirty days", async () => {
    const { token } = await vibe.join();
    const { pair } = await signedIn(token);
    await vibe.pass(29 * 86_400_000);
    expect((await vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie: pair } })).status).toBe(
      200,
    );
    await vibe.pass(86_400_000 + 1000);
    expect((await vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie: pair } })).status).toBe(
      401,
    );
  });

  test("the session has the person's access as it is now, and follows the usual rules", async () => {
    const { token, handle } = await vibe.join("viewer");
    const { pair } = await signedIn(token);
    const post = await vibe.fetch(
      `${vibe.url}/v1/vibes/general/messages`,
      asBrowser(pair, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: vibe.channel(), text: "a viewer can't post" }),
      }),
    );
    expect(post.status).toBe(403);
    const whoami = await vibe.fetch(`${vibe.url}/v1/vibes/general/whoami`, {
      headers: { cookie: pair },
    });
    expect(await whoami.json()).toMatchObject({
      actor: { handle },
      role: "viewer",
      can: { "*": ["read", "react"] },
    });
  });

  test("the SDK signs a page in without ever holding a token for it", async () => {
    const { token, handle } = await vibe.join();
    // The page's fetch: the browser adds where the request is from, and keeps the cookie.
    let jar = "";
    const browser = async (input: string, init: RequestInit = {}) => {
      const headers = { ...(init.headers as Record<string, string> | undefined), origin };
      const response = await vibe.fetch(input, {
        ...init,
        headers: jar ? { ...headers, cookie: jar } : headers,
      });
      const set = response.headers.get("set-cookie");
      if (set) jar = cookieOf(response).pair;
      return response;
    };
    const ways = await signInWays({ url: vibe.url, fetch: browser });
    expect(ways.github).toBe(vibe.github !== null);
    const session = await signIn(`  ${token}\n`, { url: vibe.url, fetch: browser });
    expect(session.user.handle).toBe(handle);

    const { vibe: connect } = await import("@vibe/sdk");
    const page = connect({ url: vibe.url, fetch: browser, live: false });
    const posted = await page.post(vibe.channel(), "written from the page");
    expect(posted.by.handle).toBe(handle);
  });

  test.skipIf(!vibe.live)(
    "the live socket rides on the session, from the Vibe's own pages only",
    async () => {
      const { token, client } = await vibe.join();
      const { pair } = await signedIn(token);
      const url = `${vibe.url.replace(/^http/, "ws")}/v1/vibes/general/live`;
      // Bun's WebSocket takes headers with the handshake, which the standard type doesn't say.
      const Socket = WebSocket as unknown as new (
        url: string,
        options: { headers: Record<string, string> },
      ) => WebSocket;
      const opening = (headers: Record<string, string>) => {
        const socket = new Socket(url, { headers });
        const heard: unknown[] = [];
        socket.addEventListener("message", (event) => heard.push(event.data));
        const opened = new Promise<boolean>((resolve) => {
          socket.addEventListener("open", () => resolve(true));
          socket.addEventListener("error", () => resolve(false));
          socket.addEventListener("close", () => resolve(false));
        });
        return { socket, heard, opened };
      };

      // A page of another site can open sockets to anywhere, and the browser sends the cookie along.
      const hijack = opening({ cookie: pair, origin: "https://evil.example" });
      expect(await hijack.opened).toBe(false);
      const page = opening({ cookie: pair, origin });
      expect(await page.opened).toBe(true);
      await client.post(vibe.channel(), "something happened");
      const deadline = Date.now() + 5000;
      while (page.heard.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(page.heard.length).toBeGreaterThan(0);
      page.socket.close();
    },
  );

  test.skipIf(vibe.github === null)(
    "GitHub's device flow ends in a session, and mints no token",
    async () => {
      const stub = vibe.github;
      if (!stub) return;
      const { handle } = await vibe.join();
      const login = `gh-${handle}`;
      const linked = await vibe.fetch(`${vibe.url}/v1/admin/users/${handle}/github`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${vibe.adminSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ github: login }),
      });
      expect(linked.status).toBe(200);

      let cookie = "";
      const bodies: string[] = [];
      const browser = async (input: string, init: RequestInit = {}) => {
        const response = await vibe.fetch(input, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), origin },
        });
        if (response.headers.get("set-cookie")) cookie = cookieOf(response).pair;
        bodies.push(await response.clone().text());
        return response;
      };
      const session = await signInWithGitHub({
        url: vibe.url,
        fetch: browser,
        sleep: async () => {},
        onCode(code) {
          stub.approve(code.userCode, { id: 990_000 + Math.floor(Math.random() * 9999), login });
        },
      });
      expect(session).toMatchObject({ user: { handle }, created: false });
      expect(cookie).toStartWith(`${COOKIE}=vibe_ses_`);
      // Nothing the page was told is a credential.
      expect(bodies.join("\n")).not.toMatch(/vibe_sk_|vibe_ses_/);
      const whoami = await vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie } });
      expect(await whoami.json()).toMatchObject({ actor: { handle } });
    },
  );
});

describe("a person's sessions", () => {
  const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
  const failing = (work: Promise<unknown>) => work.then(() => "nothing", code);
  const alive = async (cookie: string) =>
    (await vibe.fetch(`${vibe.url}/v1/whoami`, { headers: { cookie } })).status === 200;

  /** Signs a browser in, as one that calls itself something. */
  async function browser(token: string, userAgent: string) {
    const response = await vibe.fetch(`${vibe.url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "user-agent": userAgent },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(201);
    return cookieOf(response).pair;
  }

  test("are listed with what tells them apart, whichever way they ask", async () => {
    const { token, client } = await vibe.join();
    const desk = await browser(token, "Firefox on a desk");
    const phone = await browser(token, `Safari   on a phone ${"x".repeat(400)}`);

    const listed = await client.sessions();
    expect(listed.map((each) => [each.userAgent?.slice(0, 23), each.current])).toEqual([
      ["Firefox on a desk", false],
      // What a browser says of itself is kept as one line of text, cut short.
      ["Safari on a phone xxxxx", false],
    ]);
    expect(listed[1]?.userAgent).toHaveLength(200);
    const [first] = listed;
    expect(first?.id).toStartWith("ses_");
    expect(Date.parse(first?.expiresAt ?? "") - Date.parse(first?.createdAt ?? "")).toBe(
      30 * 86_400_000,
    );
    // Which token opened each, by its ID.
    const [held] = await client.tokens();
    expect(listed.map((each) => each.openedWith)).toEqual([held?.id ?? "", held?.id ?? ""]);
    // Never what is in the cookie.
    const said = JSON.stringify(listed);
    for (const cookie of [desk, phone]) expect(said).not.toContain(cookie.split("=")[1] ?? "?");
    expect(said).not.toContain("vibe_ses_");

    // From one of the browsers, that one is marked.
    const fromPhone = await vibe.fetch(`${vibe.url}/v1/sessions`, { headers: { cookie: phone } });
    expect(fromPhone.status).toBe(200);
    const page = (await fromPhone.json()) as { sessions: { id: string; current: boolean }[] };
    expect(page.sessions.map((each) => each.current)).toEqual([false, true]);
    // Someone else sees none of them.
    const { client: other } = await vibe.join();
    expect(await other.sessions()).toEqual([]);
  });

  test("one is ended from elsewhere, and its browser is signed out", async () => {
    const { token, client } = await vibe.join();
    const { client: other } = await vibe.join("owner");
    const desk = await browser(token, "the desk");
    const phone = await browser(token, "the phone");
    const [atDesk, atPhone] = await client.sessions();
    if (!atDesk || !atPhone) throw new Error("The sessions are not listed.");

    // Not by someone else, an owner included, who isn't told it exists.
    expect(await failing(other.endSession(atPhone.id))).toBe("session_not_found");
    expect(await alive(phone)).toBe(true);

    await client.endSession(atPhone.id);
    expect(await alive(phone)).toBe(false);
    expect(await alive(desk)).toBe(true);
    expect((await client.sessions()).map((each) => each.id)).toEqual([atDesk.id]);
    expect(await failing(client.endSession(atPhone.id))).toBe("session_not_found");
    expect(await failing(client.endSession("ses_none"))).toBe("session_not_found");
  });

  test("one browser ends another's session, from the Vibe's own pages only", async () => {
    const { token, client } = await vibe.join();
    const desk = await browser(token, "the desk");
    const phone = await browser(token, "the phone");
    const [, atPhone] = await client.sessions();
    const end = (headers: Record<string, string>) =>
      vibe.fetch(`${vibe.url}/v1/sessions/${atPhone?.id}`, { method: "DELETE", headers });

    expect((await end({ cookie: desk, origin: "https://evil.example" })).status).toBe(403);
    expect((await end({ cookie: desk })).status).toBe(403);
    expect(await alive(phone)).toBe(true);

    const ended = await end({ cookie: desk, origin });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toEqual({ ended: true, id: atPhone?.id ?? "" });
    expect(await alive(phone)).toBe(false);
    expect(await alive(desk)).toBe(true);
  });

  test.skipIf(!vibe.canJump)(
    "the scheduler's pass clears the rows of sessions that are over",
    async () => {
      const pass = async () => {
        const response = await vibe.fetch(`${vibe.url}/v1/admin/tick`, {
          method: "POST",
          headers: { authorization: `Bearer ${vibe.adminSecret}` },
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { cleared: { sessions: number; tokens: number } };
      };
      const { token, client } = await vibe.join();
      // Whatever earlier tests left is cleared first, so the count below is this test's.
      await pass();
      await browser(token, "an old browser");
      await browser(token, "another old one");
      expect((await pass()).cleared.sessions).toBe(0);

      await vibe.pass(29 * 86_400_000);
      const recent = await browser(token, "a recent one");
      await vibe.pass(86_400_000 + 1000);
      // Over because of the time, whether or not a pass has run.
      expect((await client.sessions()).map((each) => each.userAgent)).toEqual(["a recent one"]);

      expect((await pass()).cleared.sessions).toBeGreaterThanOrEqual(2);
      expect((await pass()).cleared.sessions).toBe(0);
      expect(await alive(recent)).toBe(true);
      expect(await client.sessions()).toHaveLength(1);
    },
  );
});
