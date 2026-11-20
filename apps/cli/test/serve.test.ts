import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vibe } from "@vibe/sdk";

const MAIN = join(import.meta.dir, "../src/main.ts");

interface Served {
  url: string;
  token: string;
  handle: string;
  adminSecret: string;
  dir: string;
  /** Stops it as Ctrl-C would, and resolves with its exit code. */
  stop(): Promise<number>;
}

const running: Served[] = [];
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vibe-serve-")));
afterAll(async () => {
  for (const served of running) await served.stop().catch(() => {});
  rmSync(scratch, { recursive: true, force: true });
});

/** Starts `vibe serve` on a free port, and resolves once it has said where it is. */
async function serve(args: string[], cwd: string): Promise<Served> {
  const child = Bun.spawn(["bun", MAIN, "serve", "--port", "0", "--json", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
    // Nothing of the surrounding shell's Vibe may leak in.
    env: { ...process.env, VIBE_ADMIN_SECRET: undefined, VIBE_PORT: undefined },
  });
  const reader = child.stdout.getReader();
  let said = "";
  while (!said.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`vibe serve exited before it said where it is: ${said}`);
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const served: Served = {
    ...(JSON.parse(said.slice(0, said.indexOf("\n"))) as Omit<Served, "stop">),
    async stop() {
      child.kill("SIGINT");
      return child.exited;
    },
  };
  running.push(served);
  return served;
}

/** Runs one `vibe` command to its end, with a config directory of its own. */
async function run(args: string[], config: string, stdin = "") {
  const child = Bun.spawn(["bun", MAIN, ...args], {
    cwd: scratch,
    stdin: new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: config,
      VIBE_URL: undefined,
      VIBE_TOKEN: undefined,
      VIBE_PROFILE: undefined,
      VIBE_NAME: undefined,
    },
  });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, exit };
}

describe("vibe login", () => {
  test("takes a token as before, and says so when the Vibe has no GitHub sign-in", async () => {
    const served = await serve(["--dir", join(scratch, "login")], scratch);
    const config = join(scratch, "config");

    // With no token to give and no GitHub app on the Vibe, there is nothing to sign in with.
    const none = await run(["login", served.url], config);
    expect(none.exit).toBe(2);
    expect(none.err).toContain("This Vibe has no GitHub sign-in");
    expect(none.err).toContain("--token");

    // A token passed as a flag, or on stdin, logs in. What it saved is what later commands use.
    const flagged = await run(["login", served.url, "--token", served.token], config);
    expect([flagged.exit, flagged.out]).toEqual([
      0,
      `Logged in as ${served.handle}. Saved to ${join(config, "vibe/config.json")}.\n`,
    ]);
    const piped = await run(
      ["login", served.url, "--json"],
      join(scratch, "config-2"),
      served.token,
    );
    expect(piped.exit).toBe(0);
    const me = await run(["whoami", "--json"], config);
    expect(JSON.parse(me.out)).toMatchObject({
      actor: { handle: served.handle },
      role: "owner",
      url: served.url,
    });

    // The operator's secret still adds people, and now says which GitHub account is theirs.
    const added = await run(
      ["admin", "user", "create", "ada", "--github", "Ada-Lovelace", "--url", served.url],
      config,
    );
    expect(added.exit).toBe(2);
    const secret = ["--admin-secret", served.adminSecret, "--url", served.url];
    const made = await run(
      ["admin", "user", "create", "ada", "--github", "Ada-Lovelace", ...secret],
      config,
    );
    expect(made.exit).toBe(0);
    expect(made.out).toContain("Added ada as member.");
    expect(made.out).toContain("vibe_sk_");
    const linked = await run(
      ["admin", "user", "link", "ada", "--github", "ada", ...secret],
      config,
    );
    expect([linked.exit, linked.out]).toEqual([
      0,
      "ada signs in as the GitHub account ada, from their next `vibe login`.\n",
    ]);
    await served.stop();
  });
});

describe("vibe serve", () => {
  test("keeps a Vibe in .vibe/ at the root of the Git checkout, and prints what reaches it", async () => {
    const repo = join(scratch, "repo");
    mkdirSync(join(repo, "packages/app"), { recursive: true });
    Bun.spawnSync(["git", "init", "--quiet", repo]);

    // Started from deep inside the checkout, it still keeps to the root.
    const served = await serve([], join(repo, "packages/app"));
    expect(served.dir).toBe(join(repo, ".vibe"));
    expect(served.url).toStartWith("http://127.0.0.1:");
    expect(existsSync(join(repo, ".vibe/vibe.db"))).toBe(true);
    // The directory keeps itself out of the repository, and its secrets to its owner.
    expect(readFileSync(join(repo, ".vibe/.gitignore"), "utf8")).toBe("*\n");
    expect(statSync(join(repo, ".vibe/serve.json")).mode & 0o077).toBe(0);
    const untracked = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain"]);
    expect(untracked.stdout.toString()).not.toContain(".vibe");

    // The token it printed owns the Vibe.
    const client = vibe({ url: served.url, token: served.token, live: false });
    const me = await client.whoami();
    expect([me.actor.handle, me.role]).toEqual([served.handle, "owner"]);
    expect(await served.stop()).toBe(130);
  });

  test("keeps messages and files across a restart, with the same token, and hears a post live", async () => {
    const dir = join(scratch, "kept");
    const first = await serve(["--dir", dir], scratch);
    const before = vibe({ url: first.url, token: first.token });
    const file = await before.upload({
      name: "trace.txt",
      data: "what happened",
      type: "text/plain",
    });
    const root = await before.post("dev", "is the deploy done?", { attachments: [file.id] });

    // The live socket: a waiter hears a reply the moment it is written.
    const waiting = before.wait({ re: root.id, after: root.id }, { timeout: "20s" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    const reply = await before.as("fx").reply(root.id, "yes");
    expect((await waiting)?.message?.id).toBe(reply.id);
    expect(Date.now() - started).toBeLessThan(5000);
    await first.stop();

    // Started again on what it left: nothing is migrated twice, nothing is lost.
    const second = await serve(["--dir", dir], scratch);
    expect([second.token, second.adminSecret]).toEqual([first.token, first.adminSecret]);
    const after = vibe({ url: second.url, token: second.token, live: false });
    const thread = await after.thread(root.id);
    expect(thread.replies.map((each) => each.by.handle)).toEqual([`${first.handle}/fx`]);
    const download = await after.download(file.id);
    expect(await download.response.text()).toBe("what happened");

    // The operator's secret it printed adds people.
    const added = await fetch(`${second.url}/v1/admin/users`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${second.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ handle: "bob" }),
    });
    expect(added.status).toBe(201);
    await second.stop();
  });
});

describe("vibe tokens and vibe sessions", () => {
  test("list what lets you in, and end one of them from the command line", async () => {
    const served = await serve(["--dir", join(scratch, "credentials")], scratch);
    const config = join(scratch, "config-credentials");
    const as = (token: string, ...args: string[]) =>
      run([...args, "--url", served.url, "--token", token], config);
    const operator = (...args: string[]) =>
      run(["admin", ...args, "--url", served.url, "--admin-secret", served.adminSecret], config);

    // A second token for the owner, as an operator hands one out, and a browser signed in with it.
    const minted = await fetch(`${served.url}/v1/admin/users/${served.handle}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${served.adminSecret}` },
    });
    const { token: spare } = (await minted.json()) as { token: string };
    const signedIn = await fetch(`${served.url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "A browser on a shelf" },
      body: JSON.stringify({ token: spare }),
    });
    expect(signedIn.status).toBe(201);
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split("; ")[0] ?? "";

    const listed = await as(served.token, "tokens");
    expect(listed.exit).toBe(0);
    const lines = listed.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^tok_\w+\s+user\s+initial\s+made \d+s ago\s+\(this one\)$/);
    expect(lines[1]).toMatch(/^tok_\w+\s+user\s+\(no label\)\s+made \d+s ago$/);
    // What is printed is never a secret.
    expect(listed.out).not.toContain("vibe_sk_");
    const spareId = lines[1]?.split(/\s+/)[0] ?? "";

    const browsers = await as(served.token, "sessions", "--json");
    const { sessions } = JSON.parse(browsers.out) as {
      sessions: { id: string; userAgent: string; openedWith: string }[];
    };
    expect(sessions).toMatchObject([{ userAgent: "A browser on a shelf", openedWith: spareId }]);
    expect((await as(served.token, "sessions")).out).toContain("A browser on a shelf");

    // The operator sees the same tokens, and a service's are its owner's to list.
    const seen = await operator("user", "tokens", served.handle, "--json");
    expect((JSON.parse(seen.out) as { tokens: unknown[] }).tokens).toHaveLength(2);
    const ci = (await as(served.token, "services", "create", "ci")).out.trim();
    const second = (await as(served.token, "services", "token", "ci")).out.trim();
    const ofService = await as(served.token, "services", "tokens", "ci", "--json");
    const [first] = (JSON.parse(ofService.out) as { tokens: { id: string; label: string }[] })
      .tokens;
    expect(first?.label).toBe("initial");
    const gone = await as(served.token, "services", "revoke", "ci", first?.id ?? "");
    expect(gone.out).toStartWith(`revoked ${first?.id}.`);
    expect((await as(ci, "whoami")).exit).toBe(1);
    expect((await as(second, "whoami")).exit).toBe(0);

    // Revoking the spare token ends the browser it signed in.
    const revoked = await as(served.token, "tokens", "revoke", spareId);
    expect([revoked.exit, revoked.out]).toEqual([
      0,
      `revoked ${spareId}. Delegated tokens minted with it, and browser sessions opened with it, ended too.\n`,
    ]);
    const refused = await as(spare, "whoami", "--json");
    expect(refused.exit).toBe(1);
    expect(JSON.parse(refused.err)).toMatchObject({ reason: "unauthorized" });
    expect((await fetch(`${served.url}/v1/whoami`, { headers: { cookie } })).status).toBe(401);
    expect((await as(served.token, "sessions")).out).toBe("You are signed in from no browser.\n");

    // A session is ended by its ID. One that isn't there says so.
    const again = await fetch(`${served.url}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: served.token }),
    });
    const kept = (again.headers.get("set-cookie") ?? "").split("; ")[0] ?? "";
    const open = JSON.parse((await as(served.token, "sessions", "--json")).out) as {
      sessions: { id: string }[];
    };
    const ended = await as(served.token, "sessions", "end", open.sessions[0]?.id ?? "");
    expect(ended.out).toContain("that browser is signed out");
    expect((await fetch(`${served.url}/v1/whoami`, { headers: { cookie: kept } })).status).toBe(
      401,
    );
    const missing = await as(served.token, "sessions", "end", "ses_none");
    expect([missing.exit, missing.err.split(":")[0]]).toEqual([1, "session_not_found"]);

    // The operator revokes a person's token, for the one lost with its machine.
    const lost = await operator("user", "revoke", served.handle, lines[0]?.split(/\s+/)[0] ?? "");
    expect(lost.out).toStartWith("revoked tok_");
    expect((await as(served.token, "whoami")).exit).toBe(1);
    // Called wrongly, each says how it is called.
    expect((await as(served.token, "tokens", "revoke")).exit).toBe(2);
    expect((await run(["tokens", "bogus", "--url", served.url], config)).exit).toBe(2);
  });

  test("refused credentials are counted against the address a proxy names, never this machine's own", async () => {
    const attempt = async (url: string, headers: Record<string, string> = {}) => {
      const response = await fetch(`${url}/v1/whoami`, {
        headers: { authorization: "Bearer vibe_sk_nobody", ...headers },
      });
      return response.status;
    };
    /** How many refusals it takes before the answer is "too many", up to two budgets' worth. */
    const untilTooMany = async (url: string, headers: Record<string, string> = {}) => {
      for (let n = 0; n <= 61; n++) if ((await attempt(url, headers)) === 429) return n;
      return -1;
    };

    // No proxy named: a connection from this machine is never counted, so a
    // stale agent beside it can't lock its owner out, and a header claims nothing.
    const dir = join(scratch, "direct");
    const direct = await serve(["--dir", dir], scratch);
    expect(await untilTooMany(direct.url, { "x-forwarded-for": "203.0.113.9" })).toBe(-1);
    const owner = await fetch(`${direct.url}/v1/whoami`, {
      headers: { authorization: `Bearer ${direct.token}` },
    });
    expect(owner.status).toBe(200);
    // Started again, it is the same Vibe with the same token: nothing was minted beside it.
    await direct.stop();
    const again = await serve(["--dir", dir], scratch);
    expect(again.token).toBe(direct.token);

    // Behind a proxy that says who is asking, each client is counted apart.
    const proxied = await serve(
      ["--dir", join(scratch, "proxied"), "--address-header", "x-forwarded-for"],
      scratch,
    );
    const one = { "x-forwarded-for": "203.0.113.9, 198.51.100.7" };
    expect(await untilTooMany(proxied.url, one)).toBeGreaterThanOrEqual(30);
    // The address the proxy added is the last one: what came before it is the client's own claim.
    expect(await attempt(proxied.url, { "x-forwarded-for": "192.0.2.1, 198.51.100.7" })).toBe(429);
    // With the port a proxy may add, it is the same caller still.
    expect(await attempt(proxied.url, { "x-forwarded-for": "198.51.100.7:40312" })).toBe(429);
    expect(await attempt(proxied.url, { "x-forwarded-for": "198.51.100.7, 198.51.100.8" })).toBe(
      401,
    );
    // A request that came round the proxy, from this machine, is not counted either.
    expect(await untilTooMany(proxied.url)).toBe(-1);

    // What isn't the name of a header is refused at the start, not at every request.
    const child = Bun.spawn(
      [
        "bun",
        MAIN,
        "serve",
        "--port",
        "0",
        "--dir",
        join(scratch, "bad"),
        "--address-header",
        "x y",
      ],
      { cwd: scratch, stdout: "pipe", stderr: "pipe" },
    );
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain("is not the name of a header");
  });
});

describe("vibe serve --public-url", () => {
  test("behind a proxy that ends TLS, a browser signs in at the address people use", async () => {
    const origin = "https://vibe.example.test";
    const served = await serve(
      ["--dir", join(scratch, "public"), "--public-url", `${origin}/`],
      scratch,
    );
    // It says where people reach it, and where the proxy reaches it.
    expect(served.url).toBe(origin);
    const { listening } = served as Served & { listening: string };
    expect(listening).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // What the proxy passes on: plain http, from a page at the public address.
    const signIn = (from: string) =>
      fetch(`${listening}/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: from },
        body: JSON.stringify({ token: served.token }),
      });
    const signed = await signIn(origin);
    expect(signed.status).toBe(201);
    const [pair = "", ...attributes] = (signed.headers.get("set-cookie") ?? "").split("; ");
    // The cookie a browser keeps for an https origin alone, and never sends in the clear.
    expect(pair).toStartWith("__Host-vibe_session=");
    expect(attributes).toContain("Secure");
    const whoami = await fetch(`${listening}/v1/whoami`, { headers: { cookie: pair } });
    expect(await whoami.json()).toMatchObject({ actor: { handle: served.handle } });
    // A page anywhere else is still refused, the address it listens on included.
    expect((await signIn("https://evil.example")).status).toBe(403);
    expect((await signIn(listening)).status).toBe(403);

    // Everything else goes on as before: a file up and down, and the live socket.
    const client = vibe({ url: listening, token: served.token });
    const file = await client.upload({ name: "notes.txt", data: "kept whole ✓" });
    const posted = await client.post("dev", "with a file", { attachments: [file.id] });
    expect(await (await client.download(file.id)).response.text()).toBe("kept whole ✓");
    const waiting = client.wait({ after: posted.id }, { timeout: "10s" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const reply = await client.reply(posted.id, "heard at once");
    expect((await waiting)?.message?.id).toBe(reply.id);
  });

  test("an address that isn't one is refused at the start", async () => {
    for (const bad of ["vibe.example.test", "https://vibe.example.test/app", "ftp://x"]) {
      const child = Bun.spawn(
        [
          "bun",
          MAIN,
          "serve",
          "--port",
          "0",
          "--dir",
          join(scratch, "bad-url"),
          "--public-url",
          bad,
        ],
        { cwd: scratch, stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(2);
    }
  });
});

describe("a saved login", () => {
  test("is sent to the Vibe it was saved for, and to no other", async () => {
    const served = await serve(["--dir", join(scratch, "saved-login")], scratch);
    const config = join(scratch, "config-saved-login");
    expect((await run(["login", served.url, "--token", served.token], config)).exit).toBe(0);

    // Another server, which keeps whatever credential it is shown.
    const shown: (string | null)[] = [];
    const other = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        shown.push(request.headers.get("authorization"));
        return Response.json({ code: "unauthorized", message: "No." }, { status: 401 });
      },
    });
    try {
      const elsewhere = `http://127.0.0.1:${other.port}`;
      for (const pointed of [
        () => run(["whoami", "--url", elsewhere], config),
        () => run(["post", "dev", "hello", "--url", elsewhere], config),
      ]) {
        const refused = await pointed();
        expect(refused.exit).toBe(2);
        expect(refused.err).toContain(`Your saved login is for ${served.url}`);
      }
      // Nothing was sent there at all, the token least of all.
      expect(shown).toEqual([]);

      // A token given for the other Vibe is that Vibe's to have.
      await run(["whoami", "--url", elsewhere, "--token", "vibe_sk_for-the-other"], config);
      expect(shown).toEqual(["Bearer vibe_sk_for-the-other"]);
      // And the saved one still works where it belongs, however the address is spelled.
      expect((await run(["whoami"], config)).exit).toBe(0);
      expect((await run(["whoami", "--url", `${served.url}/`], config)).exit).toBe(0);
    } finally {
      await other.stop(true);
    }
  });
});

describe("vibe tasks run", () => {
  test("stops the command when its lease runs out and the vibe can't be reached to renew it", async () => {
    const served = await serve(["--dir", join(scratch, "lease")], scratch);
    const config = join(scratch, "config-lease");
    const client = vibe({ url: served.url, token: served.token });
    const task = await client.tasks.create("work", "a long job");
    // Work that takes far longer than the lease.
    const started = Date.now();
    const runner = Bun.spawn(
      [
        "bun",
        MAIN,
        "tasks",
        "run",
        task.task.id,
        "--lease",
        "3s",
        "--url",
        served.url,
        "--token",
        served.token,
        "--",
        "sleep",
        "20",
      ],
      {
        cwd: scratch,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, XDG_CONFIG_HOME: config },
      },
    );
    // Once it holds the task, the vibe goes away.
    const deadline = Date.now() + 10_000;
    while ((await client.tasks.get(task.task.id)).task.state !== "claimed") {
      if (Date.now() > deadline) throw new Error("The task was never claimed.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await served.stop();

    const [exit, err] = await Promise.all([runner.exited, new Response(runner.stderr).text()]);
    // Stopped at the end of the lease it last had confirmed, not when the work was done.
    expect(exit).toBe(1);
    expect(err).toContain("ran out before it could be renewed");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe("what the task commands say", () => {
  test("a wait says what changed, and only a waiting task waits for anything", async () => {
    const served = await serve(["--dir", join(scratch, "said")], scratch);
    const config = join(scratch, "config-said");
    const at = ["--url", served.url, "--token", served.token];
    const lead = vibe({ url: served.url, token: served.token });
    const build = await lead.tasks.create("said", "build it");
    const check = await lead.tasks.create("said", { text: "check it", needs: [build.task.id] });
    const { cursor } = await lead.poll({ channel: "said" });

    const waiting = await run(["tasks", "said", ...at], config);
    expect(waiting.out).toContain(`waits for ${build.task.id}`);

    // A claim leaves the task's message as it was. The wait says the claim.
    const claim = await lead.as("builder").tasks.claim(build.task.id);
    const claimed = await run(["wait", build.task.id, "--after", cursor, ...at], config);
    expect(claimed.exit).toBe(0);
    expect(claimed.out).toContain("task.claimed");
    expect(claimed.out).toMatch(/via .* claimed it until \d{4}-/);
    expect(claimed.out).toContain("build it");

    const since = (await lead.poll({ channel: "said" })).cursor;
    await claim?.complete("built, and it runs");
    const settled = await run(["wait", build.task.id, "--after", since, ...at], config);
    expect(settled.out).toContain("completed it: built, and it runs");

    // An agent's question is answered by its person, not by its own next line.
    const asked = await lead.as("builder").reply(build.task.id, "which branch?");
    await lead.as("builder").reply(build.task.id, "still here");
    const answer = await lead.reply(build.task.id, "main");
    const only = ["wait", build.task.id, "--after", asked.id, "--by", `=${served.handle}`];
    const answered = await run([...only, "--json", ...at], config);
    expect(JSON.parse(answered.out)).toMatchObject({
      event: { message: { id: answer.id } },
      next: expect.stringContaining(`--by =${served.handle} --after `),
    });

    // What it waited for is done, so it waits for nothing, ready or held.
    const ready = await run(["tasks", "said", ...at], config);
    expect(ready.out).toContain("check it");
    expect(ready.out).toContain("task: ready");
    expect(ready.out).not.toContain("waits for");
    expect(check.task.needs).toEqual([build.task.id]);
  }, 30_000);

  test("a claim that finds nothing ready says whether anything is left", async () => {
    const served = await serve(["--dir", join(scratch, "left")], scratch);
    const config = join(scratch, "config-left");
    const at = ["--url", served.url, "--token", served.token];
    const lead = vibe({ url: served.url, token: served.token });
    const first = await lead.tasks.create("left", "the first");
    await lead.tasks.create("left", { text: "the second", needs: [first.task.id] });
    const held = await lead.as("builder").tasks.claim(first.task.id);

    const busy = await run(["tasks", "claim", "--ready", "left", "--as", "other", ...at], config);
    expect(busy.exit).not.toBe(0);
    expect(busy.err).toContain("No task is ready to claim here.");
    expect(busy.err).toContain(
      "2 still open here: 1 claimed by someone, 1 waiting for other tasks. One may yet come your way.",
    );
    const waited = await run(
      ["tasks", "claim", "--ready", "left", "--wait", "1s", "--as", "other", "--json", ...at],
      config,
    );
    expect(JSON.parse(waited.err)).toMatchObject({
      reason: "timeout",
      hint: expect.stringContaining("2 still open here"),
    });

    await held?.complete("done");
    const second = await lead.as("builder").tasks.claim({ channel: "left" });
    await second?.complete("done too");
    const none = await run(["tasks", "claim", "--ready", "left", "--as", "other", ...at], config);
    expect(none.err).toContain("Nothing is left here: every matching task is finished.");
  }, 30_000);
});

/** Whether this machine takes connections on IPv6's own loopback. Some containers don't. */
const ipv6 = (() => {
  try {
    Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
})();

describe("vibe serve --host", () => {
  test.skipIf(!ipv6)("starts on an address that is IPv6 alone", async () => {
    const served = await serve(["--dir", join(scratch, "ipv6"), "--host", "::1"], scratch);
    expect(served.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    const me = await vibe({ url: served.url, token: served.token }).whoami();
    expect(me.actor.handle).toBe(served.handle);
  });
});
