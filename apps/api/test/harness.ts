import { setDefaultTimeout } from "bun:test";

import { vibe, type VibeHandle } from "@vibe/sdk";
import { createVibe } from "@vibe/server";
import { createDb } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";
import { memoryBlobStore } from "@vibe/store/memory";

import { type GitHubStub, githubStub } from "./github-stub.ts";
import { type PlatformStubs, platformStubs } from "./platform-stubs.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface Harness {
  url: string;
  fetch: Fetch;
  adminSecret: string;
  /** Adds a person with a unique handle, and returns a client that acts as them. */
  join(
    role?: "owner" | "member" | "viewer",
  ): Promise<{ handle: string; token: string; client: VibeHandle }>;
  /** A client that acts as a team owner, whoever was first to join the team. */
  owner(): Promise<VibeHandle>;
  /** A client that acts with a token, whoever's it is. */
  connect(token: string): VibeHandle;
  /** A name no other test, or earlier run, has used: fit for a service, a watcher or a profile. */
  name(prefix?: string): string;
  /** A channel name no other test, or earlier run, has used. */
  channel(prefix?: string): string;
  /**
   * Runs what the scheduler runs each minute. `null` against a running Vibe,
   * where the scheduler is not ours to trigger.
   */
  sweep: (() => Promise<{ expired: number; promoted: number }>) | null;
  /**
   * Posts the schedules that are due, as the scheduler does each minute.
   * Against a running Vibe this asks for a whole pass, and there is no report
   * to return.
   */
  fireSchedules: (() => Promise<{ fired: number; stopped: number; failed: number } | null>) | null;
  /**
   * Runs one pass of everything the scheduler does each minute, through the
   * operator's route, so it works on any Vibe: due schedules, the task sweep,
   * and deliveries to watchers that are behind.
   */
  tick(): Promise<void>;
  /**
   * Lets time pass. In process the clock jumps. Against a running Vibe, whose
   * clock is not ours to move, this waits, so keep it to a second or two
   * there: `canJump` says which it is.
   */
  pass(ms: number): Promise<void>;
  canJump: boolean;
  /**
   * The GitHub that the Vibe in this process signs people in through: a stub,
   * where a test plays the person in the browser. `null` against a running
   * Vibe, whose GitHub is the real one, or none.
   */
  github: GitHubStub | null;
  /**
   * Whether the Vibe under test holds live sockets. The app in this process
   * doesn't: it has no Durable Object, and its clients long-poll.
   */
  live: boolean;
  /**
   * Whether the Vibe under test can reach a server this process opens on its
   * own machine: a watcher's receiver, or a platform's stand-in. A deployed
   * Vibe can't, so the tests that need one are skipped against it.
   */
  near: boolean;
  /**
   * Slack, GitHub and Linear, as stand-ins. What Vibe asks of a platform the
   * stand-in answers, and what a platform would send, a test signs and sends
   * with `webhook`.
   */
  platforms: PlatformStubs;
  /**
   * Where a sync entry is told its platform's API is. Nowhere, for the app in
   * this process: it asks the real addresses, and its `fetch` is the
   * stand-in. A running Vibe is pointed at the stand-in on the loopback.
   */
  platformApi(platform: "slack" | "github" | "linear"): string | undefined;
  /** Sends a sync entry a webhook, as its platform would. */
  webhook(
    source: { id: string },
    signed: { body: string; headers: Record<string, string> },
  ): Promise<Response>;
  /** The time as the Vibe under test has it, which a test in this process can have moved. */
  now(): number;
  /**
   * The same Vibe, as it would be after its operator changed the secret: a
   * new app over the same database, reached through the `fetch` this
   * returns. `null` against a running Vibe, whose secret is not ours to change.
   */
  restartedWith: ((adminSecret: string) => Fetch) | null;
  /**
   * A `fetch` whose requests come from an address of its own, which no other
   * test has used: what the limits on guessing are counted against. A test
   * that uses a budget up does it from one of these, and locks out no one else.
   */
  elsewhere(): Fetch & { address: string };
  /**
   * Whether the Vibe under test takes a request's address from what this
   * process sends. The app in this process does, and so does a Worker run
   * locally. A deployed one is told by Cloudflare, and `vibe serve` by the
   * connection unless it was started with `--address-header cf-connecting-ip`:
   * set `VIBE_TEST_ADDRESSED=false` for one that doesn't, and the tests that
   * use a budget up are skipped.
   */
  addressed: boolean;
}

/** The header a request's address travels in: Cloudflare's, which a Worker run locally passes on. */
const ADDRESS = "cf-connecting-ip";

/** An address from the range kept for documentation, in a network of its own. */
const someAddress = () => {
  const group = () => Math.floor(Math.random() * 0x10000).toString(16);
  return `2001:db8:${group()}:${group()}::1`;
};

/** A `fetch` that says where its requests come from, unless a request says so itself. */
function comingFrom(address: string, send: Fetch): Fetch {
  return (input, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has(ADDRESS)) headers.set(ADDRESS, address);
    return send(input, { ...init, headers });
  };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FAR_TIMEOUT_MS = 120_000;

/**
 * The API under test. By default that's the app in this process, on SQLite and
 * memory. With VIBE_TEST_URL set it's a running Vibe instead, so the same suite
 * checks the D1 and R2 adapters under `cf dev`, or a deployment: see `near`.
 */
export function harness(options: { signup?: boolean } = {}): Harness {
  const remote = process.env["VIBE_TEST_URL"];
  const adminSecret = process.env["VIBE_TEST_ADMIN_SECRET"] ?? "test-admin-secret";
  const run = Math.random().toString(36).slice(2, 8);
  let counter = 0;

  let url = "http://vibe.test";
  let fetcher: Fetch = (input, init) => fetch(input, init);
  let sweep: Harness["sweep"] = null;
  let fireSchedules: Harness["fireSchedules"] = null;
  let github: Harness["github"] = null;
  let pass: Harness["pass"] = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let now: Harness["now"] = () => Date.now();
  const platforms = platformStubs(() => now());
  const tick = async () => {
    const response = await fetcher(`${url}/v1/admin/tick`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminSecret}` },
    });
    if (!response.ok) throw new Error(`The scheduler did not run: ${await response.text()}`);
  };
  let restartedWith: Harness["restartedWith"] = null;
  let near = true;
  if (remote) {
    url = remote.replace(/\/$/, "");
    near = LOOPBACK.has(new URL(url).hostname);
    // Every call to a Vibe elsewhere crosses the network, and a test makes dozens.
    if (!near) setDefaultTimeout(FAR_TIMEOUT_MS);
    // A running Vibe's scheduler is asked for a pass. What the pass did to
    // others' schedules is not ours to report.
    fireSchedules = async () => {
      await tick();
      return null;
    };
  } else {
    let ahead = 0;
    github = githubStub("Iv1.vibe-under-test");
    const kept = {
      db: createDb(bunSqliteExecutor(openDatabase())),
      blobs: memoryBlobStore(),
      pollIntervalMs: 5,
      clock: { now: () => Date.now() + ahead },
      // Whatever Vibe asks of GitHub's sign-in or of a synced platform, a
      // stub answers. The rest goes out for real.
      github: { clientId: github.clientId, allowSignup: options.signup === true },
      fetch: platforms.fetch(github.fetch),
      clientAddress: (request: Request) => request.headers.get(ADDRESS),
    };
    const vibe = createVibe({ ...kept, adminSecret });
    restartedWith = (secret) => {
      const again = createVibe({ ...kept, adminSecret: secret });
      return (input, init) => again.app.handle(new Request(input, init));
    };
    now = () => Date.now() + ahead;
    fetcher = (input, init) => vibe.app.handle(new Request(input, init));
    sweep = vibe.sweep;
    fireSchedules = vibe.fireSchedules;
    pass = async (ms) => {
      ahead += ms;
    };
  }

  const addressed = !remote || (near && process.env["VIBE_TEST_ADDRESSED"] !== "false");
  // Each file's requests come from an address of its own, so the credentials
  // one file has refused, on purpose, are not counted against the next. A Vibe
  // that isn't told its callers' addresses by us is sent none: Cloudflare
  // refuses a request that names its own.
  const direct = fetcher;
  const from = (address: string): Fetch =>
    addressed ? comingFrom(address, direct) : (input, init) => direct(input, init);
  fetcher = from(someAddress());

  return {
    url,
    fetch: fetcher,
    elsewhere() {
      const address = someAddress();
      return Object.assign(from(address), { address });
    },
    addressed,
    adminSecret,
    sweep,
    fireSchedules,
    tick,
    pass,
    canJump: !remote,
    github,
    live: !!remote,
    near,
    platforms,
    platformApi: (platform) => (remote ? platforms.listen()[platform] : undefined),
    webhook: (source, signed) =>
      fetcher(`${url}/v1/sync/webhooks/${source.id}`, {
        method: "POST",
        headers: signed.headers,
        body: signed.body,
      }),
    now: () => now(),
    restartedWith,
    channel: (prefix = "t") => `${prefix}-${run}-${++counter}`,
    name: (prefix = "n") => `${prefix}-${run}-${++counter}`,
    // In process there is no socket to listen on. A running Vibe is used
    // the way the SDK uses one by default, live socket and all.
    connect: (token) => vibe({ url, token, fetch: fetcher, live: !!remote }),
    async owner() {
      return (await this.join("owner")).client;
    },
    async join(role) {
      const handle = `u-${run}-${++counter}`;
      const response = await fetcher(`${url}/v1/admin/users`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminSecret}`, "content-type": "application/json" },
        body: JSON.stringify(role ? { handle, role } : { handle }),
      });
      if (!response.ok) throw new Error(`Could not add ${handle}: ${await response.text()}`);
      const { token } = (await response.json()) as { token: string };
      return { handle, token, client: this.connect(token) };
    },
  };
}
