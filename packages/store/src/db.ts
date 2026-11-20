import { type BeginUnitOfWork, findConstraintViolation, type UnitOfWork } from "@vibe/kernel";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import * as schema from "./schema.ts";

export type Db = SqliteRemoteDatabase<typeof schema>;

export interface SqlQuery {
  sql: string;
  params: unknown[];
  method: "run" | "all" | "values" | "get";
}

/**
 * The two things a SQLite backend must do for Drizzle: run one query, and run
 * several atomically. Rows come back as arrays of values, in column order;
 * `get` returns one such array, or `undefined`.
 */
export interface SqlExecutor {
  query(query: SqlQuery): Promise<{ rows: unknown[] }>;
  batch(queries: SqlQuery[]): Promise<{ rows: unknown[] }[]>;
}

/**
 * One Drizzle database type for every runtime. Drizzle's own D1 and bun:sqlite
 * drivers are typed differently (async and sync), so repositories written for
 * one don't compile against the other. The proxy driver takes an executor instead.
 */
export function createDb(executor: SqlExecutor): Db {
  return drizzle(
    (sql, params, method) => executor.query({ sql, params, method }),
    (queries) => executor.batch(queries),
    { schema },
  );
}

type Write = BatchItem<"sqlite">;

/** Collects Drizzle statements and commits them as one atomic batch. */
export class DrizzleUnitOfWork implements UnitOfWork {
  private readonly writes: Write[] = [];
  private readonly receivers = new Map<number, (rows: never[]) => void>();
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly db: Db) {}

  add(...writes: Write[]): void {
    this.writes.push(...writes);
  }

  /**
   * Adds a write whose rows are wanted back, such as an insert that returns
   * the ID the database gave it. `receive` gets them once the commit has landed.
   */
  addReturning<Row>(write: Write, receive: (rows: Row[]) => void): void {
    this.receivers.set(this.writes.length, receive);
    this.writes.push(write);
  }

  /**
   * Runs `listener` after the commit has landed, and never when it failed.
   * For telling others, not for more writes: what a listener throws is logged
   * and goes no further, since the commit it follows can't be taken back.
   */
  onCommitted(listener: () => void): void {
    this.listeners.push(listener);
  }

  async commit(): Promise<void> {
    const [first, ...rest] = this.writes;
    if (!first) return;
    let results: unknown[];
    try {
      results = await this.db.batch([first, ...rest]);
    } catch (error) {
      throw findConstraintViolation(error) ?? error;
    }
    try {
      for (const [index, receive] of this.receivers) receive((results[index] ?? []) as never[]);
      for (const listener of this.listeners) listener();
    } catch (error) {
      console.error("A listener failed after its commit had landed.", error);
    }
  }
}

export function beginUnitOfWork(db: Db): BeginUnitOfWork {
  return () => new DrizzleUnitOfWork(db);
}

/** Repositories receive the opaque kernel `UnitOfWork`; this recovers the one they can add to. */
export function enlist(uow: UnitOfWork): DrizzleUnitOfWork {
  if (!(uow instanceof DrizzleUnitOfWork)) {
    throw new TypeError("This repository needs a unit of work from beginUnitOfWork().");
  }
  return uow;
}
