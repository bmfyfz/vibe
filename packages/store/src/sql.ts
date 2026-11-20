import { type ChannelPattern, subtreeBounds } from "@vibe/kernel";
import { and, eq, gte, lt, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// Query-building vocabulary, re-exported so the contexts share this package's
// one copy of Drizzle instead of each declaring their own.
export {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  max,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
export { type AnySQLiteColumn, alias } from "drizzle-orm/sqlite-core";

/** The condition that a channel column falls under a pattern. `undefined` when every channel does. */
export function channelMatches(column: AnySQLiteColumn, pattern: ChannelPattern): SQL | undefined {
  if (pattern.kind === "all") return undefined;
  if (pattern.kind === "exact") return eq(column, pattern.path);
  const [low, high] = subtreeBounds(pattern.prefix);
  return and(gte(column, low), lt(column, high));
}
