import { afterAll, describe, expect, test } from "bun:test";

import { type DeviceLogin, deviceLogin, signIn, vibe as connect, VibeError } from "@vibe/sdk";

import { harness } from "./harness.ts";
import { syncEntries } from "./sync-helpers.ts";

const vibe = harness();

// What each budget allows in one stretch. A test counts refusals up to the
// one that says "too many", and a run may cross from one stretch into the
// next on the way, which starts the count again: so it expects at least the
// budget, and less than two of them.
const CREDENTIALS = 30;
const OPERATOR = 10;
const WEBHOOKS = 30;
const SIGN_INS = 10;
const ASKS = 60;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What a failed call said: its code, its status, and how long it said to leave it. */
const refusal = (error: unknown) =>
  error instanceof VibeError
    ? { code: error.code, status: error.status, retryAfter: error.retryAfter }
    : { code: String(error), status: 0, retryAfter: undefined };
const refused = (work: Promise<unknown>) =>
  work.then(() => ({ code: "nothing", status: 200, retryAfter: undefined }), refusal);

/**
 * Tries until told there were too many tries, and returns how many were
 * answered some other way first, with the refusal that ended it.
 */
async function untilTooMany(
  most: number,
  attempt: () => Promise<{ code: string; status: number; retryAfter?: number | undefined }>,
) {
  const before: string[] = [];
  for (let n = 0; n <= most * 2; n++) {
    const answer = await attempt();
    if (answer.code === "rate_limited") return { before, answer };
    before.push(answer.code);
  }
  throw new Error(`No refusal after ${before.length} tries: ${[...new Set(before)].join(", ")}`);
}

/** A client with a token, whose requests come from one address. */
const from = (address: Fetch, token: string | undefined) =>
  connect({ url: vibe.url, token, fetch: address, live: false });

const BOGUS = "vibe_sk_0000000000000000000000000000000000000000";

// Where the address is not ours to say, a budget used up would be everyone's
// who shares this machine's address with the Vibe, the rest of the suite included.
describe.skipIf(!vibe.addressed)("limits on guessing a credential", () => {
  test("an address whose credentials keep being refused is refused everything, for a while", async () => {
    const { token } = await vibe.join();
    const here = vibe.elsewhere();
    const guess = () => refused(from(here, BOGUS).whoami());

    const { before, answer } = await untilTooMany(CREDENTIALS, guess);
    expect(new Set(before)).toEqual(new Set(["unauthorized"]));
    expect(before.length).toBeGreaterThanOrEqual(CREDENTIALS);
    expect(before.length).toBeLessThan(CREDENTIALS * 2);
    // The existing error model, with when to come back.
    expect(answer.status).toBe(429);
    expect(answer.retryAfter).toBeGreaterThanOrEqual(1);
    expect(answer.retryAfter).toBeLessThanOrEqual(60);
    const raw = await here(`${vibe.url}/v1/whoami`, { headers: { authorization: "Bearer x" } });
    expect(raw.status).toBe(429);
    expect(Number(raw.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await raw.json()).toMatchObject({
      code: "rate_limited",
      hint: expect.stringMatching(/^Try again in \d+ seconds\.$/),
    });

    // While it lasts nothing from there is looked at, a good token included:
    // otherwise the count would bound nothing.
    expect((await refused(from(here, token).whoami())).code).toBe("rate_limited");
    // Every kind of credential is the same budget: a session's cookie, and a token traded for one.
    const cookie = await here(`${vibe.url}/v1/whoami`, {
      headers: { cookie: "vibe_session=vibe_ses_0000000000000000000000000000000000000000" },
    });
    expect(cookie.status).toBe(429);
    expect((await refused(signIn(token, { url: vibe.url, fetch: here }))).code).toBe(
      "rate_limited",
    );

    // And no one else is refused anything.
    const there = vibe.elsewhere();
    expect((await from(there, token).whoami()).actor.principal).toStartWith("vibe:user:");
    expect((await refused(from(there, BOGUS).whoami())).code).toBe("unauthorized");
  });

  test("a token traded for a session is a guess like any other", async () => {
    const { token } = await vibe.join();
    const here = vibe.elsewhere();
    const guess = () => refused(signIn(BOGUS, { url: vibe.url, fetch: here }));

    const { before, answer } = await untilTooMany(CREDENTIALS, guess);
    expect(new Set(before)).toEqual(new Set(["unauthorized"]));
    expect(before.length).toBeGreaterThanOrEqual(CREDENTIALS);
    expect(answer.status).toBe(429);
    expect((await refused(signIn(token, { url: vibe.url, fetch: here }))).code).toBe(
      "rate_limited",
    );
    const signed = await signIn(token, { url: vibe.url, fetch: vibe.elsewhere() });
    expect(signed.user.handle).toStartWith("u-");
  });

  test("a request that shows nothing, or is refused for another reason, uses nothing up", async () => {
    const { token, client } = await vibe.join();
    const here = vibe.elsewhere();
    const minted = await client.as("fixer").createToken({ can: { "*": "all" } });

    for (let n = 0; n < CREDENTIALS + 5; n++) {
      // No credential at all: there is nothing there to have guessed.
      expect((await refused(from(here, undefined).whoami())).code).toBe("unauthorized");
      // A real token, used as it may not be.
      expect((await refused(from(here, minted.token).as("other").whoami())).code).toBe(
        "profile_locked",
      );
    }
    expect((await from(here, token).whoami()).actor.principal).toStartWith("vibe:user:");
  });
});

describe.skipIf(!vibe.addressed)("limits on the operator's secret", () => {
  /** An operator's request, with whatever is given as the secret. */
  const asOperator = async (send: Fetch, secret: string | null, handle: string) => {
    const response = await send(`${vibe.url}/v1/admin/users/${handle}/tokens`, {
      headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
    });
    const body = (await response.json()) as { code?: string };
    return {
      code: response.ok ? "nothing" : (body.code ?? "?"),
      status: response.status,
      retryAfter: Number(response.headers.get("retry-after") ?? Number.NaN),
    };
  };

  test("tries at it are counted, and the right one is refused too once they are used up", async () => {
    const { handle } = await vibe.join();
    const here = vibe.elsewhere();

    const { before, answer } = await untilTooMany(OPERATOR, () =>
      asOperator(here, "not-the-secret", handle),
    );
    expect(new Set(before)).toEqual(new Set(["forbidden"]));
    expect(before.length).toBeGreaterThanOrEqual(OPERATOR);
    expect(before.length).toBeLessThan(OPERATOR * 2);
    expect(answer.status).toBe(429);
    expect(answer.retryAfter).toBeGreaterThanOrEqual(1);
    expect(answer.retryAfter).toBeLessThanOrEqual(600);

    expect((await asOperator(here, vibe.adminSecret, handle)).code).toBe("rate_limited");
    expect((await asOperator(vibe.elsewhere(), vibe.adminSecret, handle)).code).toBe("nothing");
  });

  test("of many tries made at once, no more than the budget are compared", async () => {
    const { handle } = await vibe.join();
    const here = vibe.elsewhere();
    const answers = await Promise.all(
      Array.from({ length: OPERATOR * 4 }, () => asOperator(here, "not-the-secret", handle)),
    );
    const compared = answers.filter((answer) => answer.code === "forbidden").length;
    const turnedAway = answers.filter((answer) => answer.code === "rate_limited").length;
    expect(compared + turnedAway).toBe(OPERATOR * 4);
    expect(compared).toBeGreaterThanOrEqual(1);
    // Two budgets at most, if the tries fell either side of the end of a stretch.
    expect(compared).toBeLessThanOrEqual(OPERATOR * 2);
    expect(turnedAway).toBeGreaterThanOrEqual(OPERATOR * 2);
  });

  test("the right secret uses nothing up, and neither does a request with none", async () => {
    const { handle } = await vibe.join();
    const here = vibe.elsewhere();
    for (let n = 0; n < OPERATOR + 5; n++) {
      expect((await asOperator(here, vibe.adminSecret, handle)).code).toBe("nothing");
      expect((await asOperator(here, null, handle)).code).toBe("forbidden");
    }
    expect((await asOperator(here, vibe.adminSecret, handle)).code).toBe("nothing");
  });
});

// A webhook is signed by a stand-in for its platform, which a Vibe elsewhere can't be given.
describe.skipIf(!vibe.addressed || !vibe.near)("limits on a webhook's signature", () => {
  const entries = syncEntries(vibe);
  afterAll(() => entries.removeAll());
  const { github } = vibe.platforms;

  test("an entry's refused webhooks are counted for the address they came from, and that entry", async () => {
    const repository = github.repository("limits");
    const first = await entries.add(
      "github",
      { [repository]: vibe.channel("prs") },
      { token: null },
    );
    const second = await entries.add(
      "github",
      { [repository]: vibe.channel("prs") },
      { token: null },
    );
    let number = 0;
    const event = (secret?: string) =>
      github.signed(
        "pull_request",
        {
          ...github.about(repository),
          action: "opened",
          number: ++number,
          pull_request: github.pull(repository, number),
        },
        secret === undefined ? {} : { secret },
      );
    const send = async (
      address: Fetch,
      source: { id: string },
      signed: { body: string; headers: Record<string, string> },
    ) => {
      const response = await address(`${vibe.url}/v1/sync/webhooks/${source.id}`, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
      });
      const body = (await response.json()) as { code?: string };
      return {
        code: response.ok ? "nothing" : (body.code ?? "?"),
        status: response.status,
        retryAfter: Number(response.headers.get("retry-after") ?? Number.NaN),
      };
    };

    const here = vibe.elsewhere();
    const { before, answer } = await untilTooMany(WEBHOOKS, () =>
      send(here, first.source, event("a-guess")),
    );
    expect(new Set(before)).toEqual(new Set(["webhook_refused"]));
    expect(before.length).toBeGreaterThanOrEqual(WEBHOOKS);
    expect(before.length).toBeLessThan(WEBHOOKS * 2);
    expect(answer.status).toBe(429);
    expect(answer.retryAfter).toBeGreaterThanOrEqual(1);

    // The right signature is not looked at either, from there, for that entry.
    expect((await send(here, first.source, event())).code).toBe("rate_limited");
    // A platform sends every entry's events from the same addresses: the
    // other entry still hears from this one, and this entry from elsewhere.
    expect((await send(here, second.source, event())).code).toBe("nothing");
    expect((await send(vibe.elsewhere(), first.source, event())).code).toBe("nothing");

    // A webhook for no entry is nobody's guess, and is never counted.
    const nowhere = { id: "src_00000000000000000000000000" };
    for (let n = 0; n < WEBHOOKS + 5; n++) {
      expect((await send(here, nowhere, event())).code).toBe("source_not_found");
    }
  });
});

// Signing in through GitHub is played against a stand-in, which only the app in this process has.
describe.skipIf(vibe.github === null)("limits on signing in through GitHub", () => {
  /** The stand-in for GitHub. A test that reaches for it is skipped where there is none. */
  const stub = () => {
    if (!vibe.github) throw new Error("This test needs the stub.");
    return vibe.github;
  };

  test("sign-ins started from one address are counted, whatever comes of them", async () => {
    const github = stub();
    const here = vibe.elsewhere();
    const asked = github.requests.length;
    const start = () =>
      refused(
        deviceLogin({
          url: vibe.url,
          fetch: here,
          onCode() {
            // Nobody approves: the device gives up waiting.
            throw new VibeError("gave_up", "The device stopped waiting.", 0);
          },
        }),
      );

    const { before, answer } = await untilTooMany(SIGN_INS, start);
    expect(new Set(before)).toEqual(new Set(["gave_up"]));
    expect(before.length).toBeGreaterThanOrEqual(SIGN_INS);
    expect(before.length).toBeLessThan(SIGN_INS * 2);
    expect(answer.status).toBe(429);
    expect(answer.retryAfter).toBeLessThanOrEqual(600);
    // What was refused never reached GitHub.
    expect(github.requests.length - asked).toBe(before.length);

    // Someone else starts theirs as before.
    const other = await refused(
      deviceLogin({
        url: vibe.url,
        fetch: vibe.elsewhere(),
        onCode() {
          throw new VibeError("gave_up", "The device stopped waiting.", 0);
        },
      }),
    );
    expect(other.code).toBe("gave_up");
  });

  test("a device that asks too often is told to wait, and signs in once it has", async () => {
    const github = stub();
    const here = vibe.elsewhere();
    const handle = vibe.name("grace");
    const account = { id: 880_000 + Math.floor(Math.random() * 100_000), login: `${handle}-gh` };
    const added = await vibe.fetch(`${vibe.url}/v1/admin/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${vibe.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ handle, github: account.login }),
    });
    expect(added.status).toBe(201);

    // What the device hears back: how often it was answered, and when it was turned away.
    let asked = 0;
    let turnedAway: { after: number; retryAfter: number } | null = null;
    const listening: Fetch = async (input, init) => {
      const response = await here(input, init);
      if (input.endsWith("/v1/login/device/token")) {
        if (response.status === 429) {
          turnedAway = { after: asked, retryAfter: Number(response.headers.get("retry-after")) };
        } else asked += 1;
      }
      return response;
    };

    let shown: DeviceLogin | undefined;
    const waited: { ms: number; after: number; retryAfter: number }[] = [];
    let sleeps = 0;
    const signed = await deviceLogin({
      url: vibe.url,
      fetch: listening,
      onCode(code) {
        shown = code;
      },
      // An impatient device: it never sleeps. Vibe says when it has asked too often.
      async sleep(ms) {
        // A device that is never told to wait would ask for ever.
        if (++sleeps > ASKS * 3) throw new Error("It was never told to wait.");
        if (turnedAway === null || shown === undefined) return;
        // Told to leave it: it does, and the person approves in the meantime.
        waited.push({ ms, ...turnedAway });
        turnedAway = null;
        await vibe.pass(ms);
        github.approve(shown.userCode, { ...account, name: null });
      },
    });

    expect(signed.user.handle).toBe(handle);
    expect(waited).toHaveLength(1);
    const [wait] = waited;
    // It left it at least as long as it was told to, and never less than GitHub's five seconds.
    expect(wait?.retryAfter).toBeGreaterThanOrEqual(1);
    expect(wait?.retryAfter).toBeLessThanOrEqual(60);
    expect(wait?.ms).toBe(Math.max(5, wait?.retryAfter ?? 0) * 1000);
    // It had asked as often as the budget allows before it was turned away.
    expect(wait?.after).toBeGreaterThanOrEqual(ASKS);
    expect(wait?.after).toBeLessThan(ASKS * 2);
  });
});
