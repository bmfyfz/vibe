import { findConstraintViolation } from "@vibe/kernel";

import type { SqlExecutor, SqlQuery } from "./db.ts";

// The slice of D1's API this adapter uses, declared structurally so the package
// type-checks without the Workers runtime types. A real `D1Database` satisfies it.
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  raw<T = unknown[]>(): Promise<T[]>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<{ results?: unknown[] }[]>;
}

export function d1Executor(db: D1Like): SqlExecutor {
  const prepare = (query: SqlQuery) => db.prepare(query.sql).bind(...query.params);

  return {
    async query(query) {
      try {
        const statement = prepare(query);
        if (query.method === "run") {
          await statement.run();
          return { rows: [] };
        }
        const rows = await statement.raw();
        // Drizzle expects one row for `get`, typed loosely as `rows`.
        return { rows: (query.method === "get" ? rows[0] : rows) as unknown[] };
      } catch (error) {
        throw findConstraintViolation(error) ?? error;
      }
    },

    // D1 runs a batch as one transaction: if any statement fails, none apply.
    async batch(queries) {
      try {
        const results = await db.batch(queries.map(prepare));
        return results.map((result) => ({
          rows: (result.results ?? []).map((row) => Object.values(row as object)),
        }));
      } catch (error) {
        throw findConstraintViolation(error) ?? error;
      }
    },
  };
}
