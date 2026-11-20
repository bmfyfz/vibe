import { Database, type SQLQueryBindings } from "bun:sqlite";

import { findConstraintViolation } from "@vibe/kernel";

import { MIGRATIONS } from "../migrations/index.ts";
import type { SqlExecutor, SqlQuery } from "./db.ts";

/** Where the store keeps the record of the migrations it has applied. */
const RECORD = "vibe_migrations";

/**
 * Brings a database up to this build's schema: applies each migration it
 * hasn't had, oldest first, each in a transaction with the record that it
 * ran. It is safe to call every time a database is opened.
 *
 * @returns The names of the migrations it applied, which is none for a
 *   database that was up to date.
 * @throws When the database has had a migration this build doesn't know: it
 *   was written by a newer Vibe, and this one would misread it.
 */
export function migrate(
  db: Database,
  migrations: readonly { name: string; sql: string }[] = MIGRATIONS,
): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${RECORD} (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)`,
  );
  const recorded = db.query(`SELECT name FROM ${RECORD}`).values() as [string][];
  const done = new Set(recorded.map(([name]) => name));

  const known = new Set(migrations.map((migration) => migration.name));
  const unknown = [...done].find((name) => !known.has(name));
  if (unknown !== undefined) {
    throw new Error(
      `This database has had the migration ${unknown}, which this Vibe doesn't know. It was written by a newer Vibe: use that one.`,
    );
  }

  const record = db.query(`INSERT INTO ${RECORD} (name, applied_at) VALUES (?, ?)`);
  const applied: string[] = [];
  for (const { name, sql } of migrations) {
    if (done.has(name)) continue;
    // A migration that fails leaves nothing behind, not even its record.
    db.transaction(() => {
      db.exec(sql);
      record.run(name, Date.now());
    })();
    applied.push(name);
  }
  return applied;
}

/**
 * Opens a SQLite database and migrates it. In memory by default, which is
 * the stand-in for D1 in tests. With a file name, it is the database
 * `vibe serve` keeps.
 */
export function openDatabase(filename = ":memory:"): Database {
  const db = new Database(filename);
  db.exec("PRAGMA foreign_keys = ON");
  // Readers don't wait for the writer, and a crash loses no committed write.
  if (filename !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}

export function bunSqliteExecutor(db: Database): SqlExecutor {
  const run = (query: SqlQuery): unknown[] => {
    const statement = db.query(query.sql);
    const params = query.params as SQLQueryBindings[];
    if (query.method === "run") {
      statement.run(...params);
      return [];
    }
    const rows = statement.values(...params) ?? [];
    return (query.method === "get" ? rows[0] : rows) as unknown[];
  };

  return {
    async query(query) {
      try {
        return { rows: run(query) };
      } catch (error) {
        throw findConstraintViolation(error) ?? error;
      }
    },
    async batch(queries) {
      try {
        return db.transaction(() => queries.map((query) => ({ rows: run(query) })))();
      } catch (error) {
        throw findConstraintViolation(error) ?? error;
      }
    },
  };
}
