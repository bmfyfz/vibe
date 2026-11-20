import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";
import { beginUnitOfWork, createDb } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";

import { createIdentity, parseHandle, parseProfile } from "./index.ts";

function setup() {
  const db = createDb(bunSqliteExecutor(openDatabase()));
  return createIdentity({ db, begin: beginUnitOfWork(db) });
}

const code = (error: unknown) => (error instanceof DomainError ? error.code : String(error));

describe("handles", () => {
  test("are lowercased and validated", () => {
    expect(parseHandle("Ada")).toBe("ada");
    expect(parseHandle("fixer-1")).toBe("fixer-1");
    for (const bad of ["", "-ada", "ada-", "a/b", "a b", "x".repeat(40)]) {
      expect(() => parseHandle(bad)).toThrow(DomainError);
    }
  });
});

describe("profiles", () => {
  test("start with a letter, hold up to 32 characters, and match regardless of case", () => {
    expect(parseProfile("Fixer-1")).toBe("fixer-1");
    expect(parseProfile("x".repeat(32))).toHaveLength(32);
    for (const bad of ["", "1fx", "f_x", "a/b", "x".repeat(33)]) {
      expect(() => parseProfile(bad)).toThrow(DomainError);
    }
  });

  test("a profile is an actor of its principal, with the principal's role", async () => {
    const { service } = setup();
    const { user, token } = await service.createUser({ handle: "ada" });
    const fx = await service.authenticate(token, "FX");
    expect(fx).toMatchObject({
      actorId: `vibe:user:${user.id}+fx`,
      principal: `vibe:user:${user.id}`,
      profile: "fx",
      handle: "ada/fx",
      name: "fx",
      role: "owner",
    });
    expect((await service.authenticate(token, "  ")).profile).toBeNull();
  });
});

describe("identity", () => {
  test("the first person on a team owns it, and the rest are members", async () => {
    const { service } = setup();
    const ada = await service.createUser({ handle: "ada" });
    const bob = await service.createUser({ handle: "bob", name: "Bob" });
    expect(ada.user.role).toBe("owner");
    expect(bob.user.role).toBe("member");
    expect(bob.user.teamId).toBe(ada.user.teamId);
  });

  test("a token authenticates as its user, and only the real token does", async () => {
    const { service } = setup();
    const { user, token } = await service.createUser({ handle: "ada" });

    const caller = await service.authenticate(token);
    expect(caller).toMatchObject({
      actorId: `vibe:user:${user.id}`,
      handle: "ada",
      role: "owner",
      teamName: "default",
    });
    expect(await service.authenticate(null).catch(code)).toBe("unauthorized");
    expect(await service.authenticate(`${token}x`).catch(code)).toBe("unauthorized");
  });

  test("a handle is taken once", async () => {
    const { service } = setup();
    await service.createUser({ handle: "ada" });
    expect(await service.createUser({ handle: "ADA" }).catch(code)).toBe("handle_taken");
  });

  test("a second token works alongside the first", async () => {
    const { service } = setup();
    const { token } = await service.createUser({ handle: "ada" });
    const second = await service.mintToken({ handle: "ada", label: "ci" });
    expect(second).not.toBe(token);
    expect((await service.authenticate(second)).handle).toBe("ada");
    expect(await service.mintToken({ handle: "nobody" }).catch(code)).toBe("user_not_found");
  });

  test("viewers read but don't post", async () => {
    const { service, authorizer } = setup();
    await service.createUser({ handle: "ada" });
    const { token } = await service.createUser({ handle: "vic", role: "viewer" });
    const viewer = await service.authenticate(token);
    const resource = { vibeId: "vb_1", channel: "dev" };

    await authorizer.require(viewer, "read", resource);
    expect(await authorizer.require(viewer, "post", resource).catch(code)).toBe("forbidden");
  });
});

describe("grants", () => {
  /** An identity context whose next commit can be held back, to stage a race. */
  function staged() {
    const db = createDb(bunSqliteExecutor(openDatabase()));
    const begin = beginUnitOfWork(db);
    let gate: Promise<void> | null = null;
    const identity = createIdentity({
      db,
      begin: () => {
        const uow = begin();
        const held = gate;
        gate = null;
        if (held) {
          const commit = uow.commit.bind(uow);
          uow.commit = async () => {
            await held;
            return commit();
          };
        }
        return uow;
      },
    });
    return {
      identity,
      holdNextCommit(until: Promise<void>) {
        gate = until;
      },
    };
  }

  test("a change is decided again when the grants it was decided from have changed", async () => {
    const { identity, holdNextCommit } = staged();
    const { service, grants } = identity;
    const owner = await service.authenticate((await service.createUser({ handle: "ada" })).token);
    const alice = await service.authenticate((await service.createUser({ handle: "alice" })).token);
    await service.createUser({ handle: "bob" });
    const vibe = "vb_1";

    // Alice may change grants in ops/ because of this grant, and only because of it.
    const hers = await grants.create(owner, vibe, {
      principals: [{ kind: "user", handle: "alice" }],
      can: { "ops/": "all" },
    });
    await grants.create(owner, vibe, {
      principals: [{ kind: "everyone" }],
      can: { "ops/": "none" },
    });

    // She reads the grants and decides she may let Bob in. Before her change
    // commits, the owner revokes the grant her authority came from.
    const held = Promise.withResolvers<void>();
    holdNextCommit(held.promise);
    const letBobIn = grants
      .create(alice, vibe, {
        principals: [{ kind: "user", handle: "bob" }],
        can: { "ops/": "all" },
      })
      .catch(code);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await grants.revoke(owner, vibe, hers.id);
    held.resolve();

    // Her commit fails on the policy's revision, and deciding again refuses her.
    expect(await letBobIn).toBe("forbidden");
    const listed = await grants.list(owner, vibe);
    expect(listed.map((grant) => grant.id)).toEqual(["g1", "g2", "g4"]);
  });

  test("two changes to different grants made at once both land, one after the other", async () => {
    const { identity } = staged();
    const { service, grants } = identity;
    const owner = await service.authenticate((await service.createUser({ handle: "ada" })).token);
    const made = await Promise.all(
      ["a", "b", "c", "d"].map((channel) =>
        grants.create(owner, "vb_1", {
          principals: [{ kind: "everyone" }],
          can: { [channel]: "none" },
        }),
      ),
    );
    expect(made.map((grant) => grant.id).sort()).toEqual(["g3", "g4", "g5", "g6"]);
  });
});
