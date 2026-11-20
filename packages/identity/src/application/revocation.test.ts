import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";
import { beginUnitOfWork, createDb, schema } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";

import { browserName } from "../domain/session.ts";
import { createIdentity, SESSION_TTL_MS } from "../index.ts";

const VIBE = "vb_1";
const DAY = 86_400_000;

function setup() {
  const db = createDb(bunSqliteExecutor(openDatabase()));
  const begin = beginUnitOfWork(db);
  let now = 1_795_000_000_000;
  const identity = createIdentity({ db, begin, clock: { now: () => now } });
  return {
    ...identity,
    db,
    begin,
    pass(ms: number) {
      now += ms;
    },
  };
}

const code = (error: unknown) => (error instanceof DomainError ? error.code : String(error));
const failing = (work: Promise<unknown>) => work.then(() => "nothing", code);

describe("a principal's tokens", () => {
  test("are listed by what they are for, with the one in use marked, and never their secrets", async () => {
    const { service, tokens, delegation } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const second = await service.mintToken({ handle: "ada", label: "laptop" });
    const ada = await service.authenticate(second);
    const minted = await delegation.mint(ada, VIBE, { profile: "fixer", can: { "dev/": "all" } });

    const listed = await tokens.mine(ada);
    expect(listed.map((each) => [each.kind, each.label, each.current])).toEqual([
      ["user", "initial", false],
      ["user", "laptop", true],
      ["delegated", null, false],
    ]);
    expect(listed[2]).toMatchObject({
      id: minted.id,
      expiresAt: minted.expiresAt,
      delegated: { vibeId: VIBE, profile: "fixer", mintedWith: listed[1]?.id },
    });
    const said = JSON.stringify(listed);
    for (const secret of [token, second, minted.token]) expect(said).not.toContain(secret);
    expect(said).not.toContain("hash");
  });

  test("one that is revoked stops working, and the others carry on", async () => {
    const { service, tokens } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const second = await service.mintToken({ handle: "ada", label: "laptop" });
    const ada = await service.authenticate(token);
    const [, laptop] = await tokens.mine(ada);
    if (!laptop) throw new Error("The second token is not listed.");

    const revoked = await tokens.revokeMine(ada, laptop.id);
    expect(revoked).toMatchObject({ id: laptop.id, label: "laptop" });
    expect(revoked.revokedAt).not.toBeNull();
    expect(await failing(service.authenticate(second))).toBe("unauthorized");
    expect((await service.authenticate(token)).handle).toBe("ada");
    expect((await tokens.mine(ada)).map((each) => each.label)).toEqual(["initial"]);

    // Revoking only takes away, so saying it twice changes nothing and fails nothing.
    expect((await tokens.revokeMine(ada, laptop.id)).revokedAt).toBe(revoked.revokedAt);
  });

  test("a token revokes itself, and that was its last request", async () => {
    const { service, tokens } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const ada = await service.authenticate(token);
    const [only] = await tokens.mine(ada);
    await tokens.revokeMine(ada, only?.id ?? "");
    expect(await failing(service.authenticate(token))).toBe("unauthorized");
  });

  test("nobody revokes or learns of another's", async () => {
    const { service, tokens } = setup();
    const ada = await service.authenticate((await service.createUser({ handle: "ada" })).token);
    const bob = await service.createUser({ handle: "bob" });
    const [bobs] = await tokens.mine(await service.authenticate(bob.token));

    expect(await failing(tokens.revokeMine(ada, bobs?.id ?? ""))).toBe("token_not_found");
    expect(await failing(tokens.revokeMine(ada, "tok_none"))).toBe("token_not_found");
    expect(await failing(tokens.revokeMine(ada, "dt_none"))).toBe("token_not_found");
    expect((await service.authenticate(bob.token)).handle).toBe("bob");
  });

  test("a caller under a limit neither lists nor revokes", async () => {
    const { service, tokens, delegation } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const ada = await service.authenticate(token);
    const minted = await delegation.mint(ada, VIBE, { profile: "fixer", can: { "*": "all" } });
    const [own] = await tokens.mine(ada);

    const fixer = await service.authenticate(minted.token);
    expect(await failing(tokens.mine(fixer))).toBe("forbidden");
    expect(await failing(tokens.revokeMine(fixer, own?.id ?? ""))).toBe("forbidden");
    const held = await service.authenticate(token, null, '{"*":"all"}');
    expect(await failing(tokens.revokeMine(held, own?.id ?? ""))).toBe("forbidden");
  });

  test("a service's are a team owner's to list and revoke", async () => {
    const { service, services, tokens } = setup();
    const owner = await service.authenticate((await service.createUser({ handle: "ada" })).token);
    const member = await service.authenticate((await service.createUser({ handle: "bob" })).token);
    const ci = await services.create(owner, { name: "ci" });
    const second = await services.mintToken(owner, "ci", "runner");

    const listed = await tokens.ofService(owner, "ci");
    expect(listed.map((each) => [each.kind, each.label])).toEqual([
      ["service", "initial"],
      ["service", "runner"],
    ]);
    expect(await failing(tokens.ofService(member, "ci"))).toBe("forbidden");
    expect(await failing(tokens.revokeOfService(member, "ci", listed[0]?.id ?? ""))).toBe(
      "forbidden",
    );
    expect(await failing(tokens.ofService(owner, "nobody"))).toBe("service_not_found");
    // A person's token is not a service's, whoever asks.
    const [adas] = await tokens.mine(owner);
    expect(await failing(tokens.revokeOfService(owner, "ci", adas?.id ?? ""))).toBe(
      "token_not_found",
    );

    await tokens.revokeOfService(owner, "ci", listed[0]?.id ?? "");
    expect(await failing(service.authenticate(ci.token))).toBe("unauthorized");
    expect((await service.authenticate(second)).handle).toBe("ci");
    // The service sees its own, and can give one up.
    const itself = await service.authenticate(second);
    expect((await tokens.mine(itself)).map((each) => [each.label, each.current])).toEqual([
      ["runner", true],
    ]);
  });

  test("the operator lists and revokes a person's", async () => {
    const { service, tokens } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const [only] = await tokens.ofUser("ADA");
    expect(only).toMatchObject({ kind: "user", label: "initial", current: false });
    await tokens.revokeOfUser("ada", only?.id ?? "");
    expect(await failing(service.authenticate(token))).toBe("unauthorized");
    expect(await failing(tokens.ofUser("nobody"))).toBe("user_not_found");
  });
});

describe("delegated tokens", () => {
  test("stop working when the token that minted them is revoked, and only then", async () => {
    const { service, tokens, delegation } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const laptop = await service.mintToken({ handle: "ada", label: "laptop" });
    const fromFirst = await delegation.mint(await service.authenticate(token), VIBE, {
      profile: "fixer",
      can: { "*": "all" },
    });
    const ada = await service.authenticate(laptop);
    const fromLaptop = await delegation.mint(ada, VIBE, { profile: "fixer", can: { "*": "all" } });
    expect((await service.authenticate(fromLaptop.token)).profile).toBe("fixer");

    const mine = await tokens.mine(await service.authenticate(token));
    await tokens.revokeMine(
      await service.authenticate(token),
      mine.find((each) => each.label === "laptop")?.id ?? "",
    );

    expect(await failing(service.authenticate(fromLaptop.token))).toBe("unauthorized");
    expect((await service.authenticate(fromFirst.token)).profile).toBe("fixer");
    // And it is no longer listed among the ones that work.
    const left = await tokens.mine(await service.authenticate(token));
    expect(left.map((each) => each.id)).toContain(fromFirst.id);
    expect(left.map((each) => each.id)).not.toContain(fromLaptop.id);
  });

  test("a service's stop with the service token that minted them", async () => {
    const { service, services, tokens, delegation } = setup();
    const owner = await service.authenticate((await service.createUser({ handle: "ada" })).token);
    const ci = await services.create(owner, { name: "ci" });
    const minted = await delegation.mint(await service.authenticate(ci.token), VIBE, {
      profile: "job",
      can: { "*": ["read"] },
    });
    expect((await service.authenticate(minted.token)).handle).toBe("ci/job");
    const [first] = await tokens.ofService(owner, "ci");
    await tokens.revokeOfService(owner, "ci", first?.id ?? "");
    expect(await failing(service.authenticate(minted.token))).toBe("unauthorized");
  });

  test("one is revoked by name, by whoever it was minted from", async () => {
    const { service, tokens, delegation } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const bob = await service.authenticate((await service.createUser({ handle: "bob" })).token);
    const ada = await service.authenticate(token);
    const minted = await delegation.mint(ada, VIBE, { profile: "fixer", can: { "*": "all" } });
    const other = await delegation.mint(ada, VIBE, { profile: "fixer", can: { "*": "all" } });

    expect(await failing(tokens.revokeMine(bob, minted.id))).toBe("token_not_found");
    const revoked = await tokens.revokeMine(ada, minted.id);
    expect(revoked).toMatchObject({ id: minted.id, kind: "delegated" });
    expect(await failing(service.authenticate(minted.token))).toBe("unauthorized");
    expect((await service.authenticate(other.token)).profile).toBe("fixer");
    expect((await service.authenticate(token)).handle).toBe("ada");
    await tokens.revokeMine(ada, minted.id);
  });

  test("a caller that showed no credential mints none: it would have nothing to end with", async () => {
    const { service, delegation } = setup();
    const { user } = await service.createUser({ handle: "ada" });
    // A principal as a schedule or a watcher acts for it, with nobody there.
    const unattended = await service.callerOf(`vibe:user:${user.id}`, null);
    if (!unattended) throw new Error("The principal is not there.");
    expect(
      await failing(delegation.mint(unattended, VIBE, { profile: "fixer", can: { "*": "all" } })),
    ).toBe("forbidden");
  });

  test("only the principal's own token or session backs its delegated token", async () => {
    const { service, tokens, delegation, db } = setup();
    const ada = await service.authenticate((await service.createUser({ handle: "ada" })).token);
    const bob = await service.authenticate((await service.createUser({ handle: "bob" })).token);
    const minted = await delegation.mint(ada, VIBE, { profile: "fixer", can: { "*": "all" } });
    const [bobs] = await tokens.mine(bob);
    // As if its parent's ID were that of a token of someone else's, which works.
    await db.update(schema.delegatedTokens).set({ mintedWith: bobs?.id ?? "" });
    expect(await failing(service.authenticate(minted.token))).toBe("unauthorized");
  });

  test("one minted before its minter's token was recorded ends by itself, as before", async () => {
    const { service, delegation, db, pass } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const ada = await service.authenticate(token);
    const minted = await delegation.mint(ada, VIBE, { profile: "fixer", can: { "*": "all" } });
    await db.update(schema.delegatedTokens).set({ mintedWith: null });
    expect((await service.authenticate(minted.token)).profile).toBe("fixer");
    pass(3_600_001);
    expect(await failing(service.authenticate(minted.token))).toBe("unauthorized");
  });
});

describe("sessions", () => {
  test("a person lists theirs, and ends one from elsewhere", async () => {
    const { service, sessions } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const bob = await service.authenticate((await service.createUser({ handle: "bob" })).token);
    const work = await sessions.openWithToken(token, "Firefox on a desk");
    const phone = await sessions.openWithToken(token, "Safari on a phone");

    const byToken = await sessions.list(await service.authenticate(token));
    expect(byToken.map((each) => [each.userAgent, each.current])).toEqual([
      ["Firefox on a desk", false],
      ["Safari on a phone", false],
    ]);
    expect(JSON.stringify(byToken)).not.toContain(work.secret);
    // From one of the sessions, that one is marked.
    const atWork = await sessions.authenticate(work.secret);
    if (!atWork) throw new Error("The session does not work.");
    const fromWork = await sessions.list(atWork);
    expect(fromWork.map((each) => each.current)).toEqual([true, false]);

    // Someone else has no such session, and learns nothing of it.
    const phoneId = fromWork[1]?.id ?? "";
    expect(await failing(sessions.end(bob, phoneId))).toBe("session_not_found");
    expect(await sessions.list(bob)).toEqual([]);

    await sessions.end(atWork, phoneId);
    expect(await sessions.authenticate(phone.secret)).toBeNull();
    expect(await sessions.authenticate(work.secret)).not.toBeNull();
    expect(await failing(sessions.end(atWork, phoneId))).toBe("session_not_found");
  });

  test("a caller under a limit sees and ends none", async () => {
    const { service, sessions } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    await sessions.openWithToken(token);
    const held = await service.authenticate(token, null, '{"*":"all"}');
    const [open] = await sessions.list(await service.authenticate(token));
    expect(await failing(sessions.list(held))).toBe("forbidden");
    expect(await failing(sessions.end(held, open?.id ?? ""))).toBe("forbidden");
  });

  test("one ends with the token that opened it, and takes what it minted along", async () => {
    const { service, sessions, tokens, delegation, begin } = setup();
    const { user, token } = await service.createUser({ handle: "ada" });
    const leaked = await service.mintToken({ handle: "ada", label: "leaked" });
    const opened = await sessions.openWithToken(leaked);
    const inBrowser = await sessions.authenticate(opened.secret);
    if (!inBrowser) throw new Error("The session does not work.");
    const minted = await delegation.mint(inBrowser, VIBE, {
      profile: "fixer",
      can: { "*": "all" },
    });
    // A session opened through GitHub, where no token was shown.
    const uow = begin();
    const viaGitHub = await sessions.open(uow, user.id);
    await uow.commit();

    const ada = await service.authenticate(token);
    const mine = await tokens.mine(ada);
    await tokens.revokeMine(ada, mine.find((each) => each.label === "leaked")?.id ?? "");

    expect(await sessions.authenticate(opened.secret)).toBeNull();
    expect(await failing(service.authenticate(minted.token))).toBe("unauthorized");
    expect(await sessions.authenticate(viaGitHub.secret)).not.toBeNull();
    expect(await sessions.list(ada)).toHaveLength(1);
  });

  test("a session that slipped in beside its token's revocation is refused all the same", async () => {
    const { service, sessions, tokens, db } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const leaked = await service.mintToken({ handle: "ada", label: "leaked" });
    const ada = await service.authenticate(token);
    const opened = await sessions.openWithToken(leaked);
    const row = await db.select().from(schema.sessions).get();
    const mine = await tokens.mine(ada);
    await tokens.revokeMine(ada, mine.find((each) => each.label === "leaked")?.id ?? "");
    // As if its row had been written just after the revocation cleared the token's sessions.
    if (!row) throw new Error("The session has no row.");
    await db.insert(schema.sessions).values(row);

    expect(await sessions.authenticate(opened.secret)).toBeNull();
    expect(await sessions.list(ada)).toEqual([]);
  });

  test("a delegated token ends when the session that minted it is ended", async () => {
    const { service, sessions, delegation } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const opened = await sessions.openWithToken(token);
    const inBrowser = await sessions.authenticate(opened.secret);
    if (!inBrowser) throw new Error("The session does not work.");
    const minted = await delegation.mint(inBrowser, VIBE, {
      profile: "fixer",
      can: { "*": "all" },
    });
    expect((await service.authenticate(minted.token)).profile).toBe("fixer");
    await sessions.close(opened.secret);
    expect(await failing(service.authenticate(minted.token))).toBe("unauthorized");
  });

  test("what a browser calls itself is kept as one short line of plain text", () => {
    expect(browserName("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Mozilla/5.0 (X11; Linux x86_64)");
    expect(browserName("  a\u001b[31m\r\nb‮\tc  ")).toBe("a [31m b c");
    expect(browserName("x".repeat(500))).toHaveLength(200);
    expect(browserName("")).toBeNull();
    expect(browserName(" \n ")).toBeNull();
    expect(browserName(undefined)).toBeNull();
  });
});

describe("the scheduler's pass", () => {
  test("clears sessions that are over and tokens long expired, and nothing that works", async () => {
    const { service, sessions, delegation, upkeep, db, pass } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const ada = await service.authenticate(token);
    const old = await sessions.openWithToken(token);
    await delegation.mint(ada, VIBE, { profile: "fixer", can: { "*": "all" }, ttlMs: 60_000 });

    // Nothing is over yet.
    expect(await upkeep.run()).toEqual({ sessions: 0, tokens: 0 });
    pass(SESSION_TTL_MS - DAY);
    const recent = await sessions.openWithToken(token);
    const fresh = await delegation.mint(ada, VIBE, { profile: "fixer", can: { "*": "all" } });
    pass(DAY + 1);

    // The old session is refused whether or not a pass has run.
    expect(await sessions.authenticate(old.secret)).toBeNull();
    expect(await db.select().from(schema.sessions)).toHaveLength(2);
    expect(await upkeep.run()).toEqual({ sessions: 1, tokens: 1 });
    expect(await db.select().from(schema.sessions)).toHaveLength(1);
    expect((await db.select().from(schema.delegatedTokens)).map((row) => row.id)).toEqual([
      fresh.id,
    ]);
    expect(await sessions.authenticate(recent.secret)).not.toBeNull();
    expect(await upkeep.run()).toEqual({ sessions: 0, tokens: 0 });
  });
});
