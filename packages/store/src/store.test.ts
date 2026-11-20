import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BlobStore, ConstraintViolation } from "@vibe/kernel";

import { MIGRATIONS } from "../migrations/index.ts";
import { manifest, migrationFiles } from "../scripts/embed-migrations.ts";
import { bunSqliteExecutor, migrate, openDatabase } from "./bun-sqlite.ts";
import { fsBlobStore } from "./fs.ts";
import { beginUnitOfWork, createDb, enlist, eq, schema } from "./index.ts";
import { memoryBlobStore } from "./memory.ts";

const { events, teams } = schema;

function setup() {
  const db = createDb(bunSqliteExecutor(openDatabase()));
  return { db, begin: beginUnitOfWork(db) };
}

const event = (threadVersion: number) => ({
  vibeId: "vb_1",
  type: "message.posted",
  threadId: "msg_1",
  threadVersion,
  actorId: "vibe:user:u_1",
  payload: { n: threadVersion },
  createdAt: 1,
});

describe("unit of work", () => {
  test("commits every write, and reads map back through Drizzle", async () => {
    const { db, begin } = setup();
    const uow = begin();
    enlist(uow).add(
      db.insert(teams).values({ id: "team_1", name: "acme", createdAt: 1 }),
      db.insert(events).values(event(1)),
    );
    await uow.commit();

    expect(await db.select().from(teams)).toEqual([{ id: "team_1", name: "acme", createdAt: 1 }]);
    const row = await db.select().from(events).where(eq(events.threadId, "msg_1")).get();
    expect(row?.seq).toBe(1);
    expect(row?.payload).toEqual({ n: 1 });
    expect(await db.select().from(teams).where(eq(teams.id, "nope")).get()).toBeUndefined();
  });

  test("a stale thread version fails the whole batch and writes none of it", async () => {
    const { db, begin } = setup();
    const first = begin();
    enlist(first).add(db.insert(events).values(event(1)));
    await first.commit();

    const stale = begin();
    enlist(stale).add(
      db.insert(teams).values({ id: "team_1", name: "acme", createdAt: 1 }),
      db.insert(events).values(event(1)),
    );
    const error = await stale.commit().catch((e) => e);

    expect(error).toBeInstanceOf(ConstraintViolation);
    expect((error as ConstraintViolation).on("events")).toBe(true);
    expect(await db.select().from(teams)).toEqual([]);
  });

  test("an empty unit of work commits without touching the database", async () => {
    await setup().begin().commit();
  });

  test("hands back the rows a write returns, and tells listeners once it has landed", async () => {
    const { db, begin } = setup();
    const seen: unknown[] = [];
    const work = enlist(begin());
    work.add(db.insert(teams).values({ id: "team_1", name: "acme", createdAt: 1 }));
    work.addReturning<{ seq: number }>(
      db.insert(events).values(event(1)).returning({ seq: events.seq }),
      (rows) => seen.push(rows),
    );
    work.onCommitted(() => seen.push("committed"));
    expect(seen).toEqual([]);

    await work.commit();
    expect(seen).toEqual([[{ seq: 1 }], "committed"]);
  });

  test("a commit that fails tells no one, and a listener that throws fails nothing", async () => {
    const { db, begin } = setup();
    const first = enlist(begin());
    first.add(db.insert(events).values(event(1)));
    first.onCommitted(() => {
      throw new Error("the listener's own trouble");
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    await first.commit();
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();

    const seen: unknown[] = [];
    const stale = enlist(begin());
    stale.addReturning(db.insert(events).values(event(1)).returning({ seq: events.seq }), (rows) =>
      seen.push(rows),
    );
    stale.onCommitted(() => seen.push("committed"));
    expect(await stale.commit().catch((e) => e)).toBeInstanceOf(ConstraintViolation);
    expect(seen).toEqual([]);
  });
});

describe("migration 0002", () => {
  test("ends the sessions that were open before it, and nothing else", () => {
    const db = new Database(":memory:");
    migrate(db, MIGRATIONS.slice(0, 2));
    db.exec(`
      INSERT INTO teams (id, name, created_at) VALUES ('team_1', 'acme', 1);
      INSERT INTO users (id, team_id, handle, name, role, created_at)
        VALUES ('u_1', 'team_1', 'ada', 'Ada', 'owner', 1);
      INSERT INTO tokens (id, hash, user_id, created_at) VALUES ('tok_1', 'h1', 'u_1', 1);
      INSERT INTO sessions (id, hash, user_id, created_at, expires_at)
        VALUES ('ses_1', 'h2', 'u_1', 1, 9999999999999);
      INSERT INTO delegated_tokens
        (id, hash, principal, vibe_id, profile, can, created_by, created_at, expires_at)
        VALUES ('dt_1', 'h3', 'vibe:user:u_1', 'vb_1', 'fx', '{}', 'vibe:user:u_1', 1, 2);
    `);

    expect(migrate(db)).toEqual(["0002_revocation_and_attempts"]);
    // A session from before can't say which token opened it, so it could not end with one.
    expect(db.query("SELECT id FROM sessions").values()).toEqual([]);
    expect(db.query("SELECT id, revoked_at FROM tokens").values()).toEqual([["tok_1", null]]);
    expect(db.query("SELECT id, minted_with, revoked_at FROM delegated_tokens").values()).toEqual([
      ["dt_1", null, null],
    ]);
    expect(db.query("SELECT count(*) FROM attempts").values()).toEqual([[0]]);
  });
});

describe("migrations", () => {
  const tables = (db: Database) =>
    (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").values() as [string][]).map(
      ([name]) => name,
    );

  test("the embedded manifest holds every migration file, in order", () => {
    const files = migrationFiles();
    expect(MIGRATIONS.map((migration) => `${migration.name}.sql`)).toEqual(files);
    // Run `bun db:generate`, or `bun run --filter @vibe/store db:embed`, after adding one.
    const written = readFileSync(join(import.meta.dir, "../migrations/index.ts"), "utf8");
    expect(written).toBe(manifest(files));
    expect(MIGRATIONS[0]?.sql).toContain("CREATE TABLE");
    // drizzle-kit keeps its own list, which `cf d1 migrations apply` doesn't read. A file
    // renamed by hand has to be renamed there too.
    const journal = JSON.parse(
      readFileSync(join(import.meta.dir, "../migrations/meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((entry) => `${entry.tag}.sql`)).toEqual(files);
  });

  test("each runs once, and what ran is on record", () => {
    const db = new Database(":memory:");
    expect(migrate(db)).toEqual(MIGRATIONS.map((migration) => migration.name));
    expect(tables(db)).toContain("events");
    const recorded = db.query("SELECT name FROM vibe_migrations ORDER BY name").values();
    expect(recorded.map(([name]) => name)).toEqual(MIGRATIONS.map((migration) => migration.name));

    // Opened again, there is nothing left to do, and nothing is done twice.
    expect(migrate(db)).toEqual([]);
  });

  test("a database that is behind gets only what it is missing", () => {
    const db = new Database(":memory:");
    const [first, ...rest] = MIGRATIONS;
    if (!first) throw new Error("There are no migrations.");
    expect(migrate(db, [first])).toEqual([first.name]);
    db.exec("INSERT INTO teams (id, name, created_at) VALUES ('team_1', 'acme', 1)");

    expect(migrate(db)).toEqual(rest.map((migration) => migration.name));
    expect(db.query("SELECT name FROM teams").values()).toEqual([["acme"]]);
  });

  test("one that fails leaves nothing behind, and the next start tries it again", () => {
    const db = new Database(":memory:");
    const broken = [
      { name: "0000_ok", sql: "CREATE TABLE a (id TEXT)" },
      { name: "0001_broken", sql: "CREATE TABLE b (id TEXT); CREATE TABLE a (id TEXT)" },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(tables(db).sort()).toEqual(["a", "vibe_migrations"]);

    const fixed = [broken[0], { name: "0001_broken", sql: "CREATE TABLE b (id TEXT)" }];
    expect(migrate(db, fixed as typeof broken)).toEqual(["0001_broken"]);
  });

  test("a database from a newer Vibe is refused", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec("INSERT INTO vibe_migrations (name, applied_at) VALUES ('9999_from_the_future', 1)");
    expect(() => migrate(db)).toThrow("9999_from_the_future");
  });

  test("a database in a file keeps what was written, across opening it again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibe-store-"));
    try {
      const file = join(dir, "vibe.db");
      const first = openDatabase(file);
      first.exec("INSERT INTO teams (id, name, created_at) VALUES ('team_1', 'acme', 1)");
      first.close();

      const again = createDb(bunSqliteExecutor(openDatabase(file)));
      expect(await again.select().from(teams)).toEqual([
        { id: "team_1", name: "acme", createdAt: 1 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("blob stores", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-blobs-"));
  const stores: [string, () => BlobStore][] = [
    ["memory", memoryBlobStore],
    ["a directory", () => fsBlobStore(dir)],
  ];

  for (const [name, open] of stores) {
    test(`${name} round-trips bytes and content type`, async () => {
      const blobs = open();
      const body = new Response("hello").body as ReadableStream<Uint8Array>;
      expect(await blobs.put("team_1/vb_1/att_1", body, { contentType: "text/plain" })).toEqual({
        size: 5,
      });

      const stored = await blobs.get("team_1/vb_1/att_1");
      expect(stored?.contentType).toBe("text/plain");
      expect(stored?.size).toBe(5);
      expect(await new Response(stored?.body).text()).toBe("hello");
      expect(await blobs.get("team_1/vb_1/att_2")).toBeNull();

      await blobs.delete("team_1/vb_1/att_1");
      expect(await blobs.get("team_1/vb_1/att_1")).toBeNull();
      await blobs.delete("team_1/vb_1/att_1");
    });
  }

  test("a directory keeps a blob for whoever opens it next, and no key leaves it", async () => {
    const body = new Response("kept").body as ReadableStream<Uint8Array>;
    await fsBlobStore(dir).put("team_1/vb_1/att_9", body, { contentType: "text/x-kept" });
    const stored = await fsBlobStore(dir).get("team_1/vb_1/att_9");
    expect([await new Response(stored?.body).text(), stored?.contentType]).toEqual([
      "kept",
      "text/x-kept",
    ]);
    for (const key of ["../outside", "/etc/passwd", "a/../../b", ""]) {
      expect(fsBlobStore(dir).get(key)).rejects.toThrow("not a blob key");
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
