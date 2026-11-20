import { and, count, type Db, eq, gt, gte, inArray, lte, schema, sql } from "@vibe/store";

import type { AttemptRepository } from "../application/attempts.ts";
import type { Window } from "../domain/attempts.ts";

const { attempts } = schema;

export class DrizzleAttemptRepository implements AttemptRepository {
  constructor(private readonly db: Db) {}

  async spent(keys: readonly string[], most: number, now: number): Promise<boolean> {
    const row = await this.db
      .select({ n: count() })
      .from(attempts)
      .where(
        and(
          inArray(attempts.key, [...keys]),
          gt(attempts.expiresAt, now),
          gte(attempts.count, most),
        ),
      )
      .get();
    return (row?.n ?? 0) > 0;
  }

  async add(key: string, window: Window, most: number): Promise<boolean> {
    // One statement decides and counts, so two requests can't both take the
    // last attempt. A row from an earlier stretch is started again. One from
    // a later stretch, which a server whose clock runs ahead wrote, is
    // counted into as it is: clocks a few milliseconds apart must not reset
    // each other's counts.
    const counted = await this.db
      .insert(attempts)
      .values({ key, windowStart: window.start, count: 1, expiresAt: window.end })
      .onConflictDoUpdate({
        target: attempts.key,
        set: {
          count: sql`case when ${attempts.windowStart} >= excluded.window_start then ${attempts.count} + 1 else 1 end`,
          windowStart: sql`max(${attempts.windowStart}, excluded.window_start)`,
          expiresAt: sql`max(${attempts.expiresAt}, excluded.expires_at)`,
        },
        setWhere: sql`${attempts.windowStart} < excluded.window_start or ${attempts.count} < ${most}`,
      })
      .returning({ count: attempts.count });
    return counted.length > 0;
  }

  async subtract(key: string, window: Window): Promise<void> {
    await this.db
      .update(attempts)
      .set({ count: sql`${attempts.count} - 1` })
      .where(
        and(eq(attempts.key, key), eq(attempts.windowStart, window.start), gt(attempts.count, 0)),
      );
  }

  async prune(now: number): Promise<void> {
    await this.db.delete(attempts).where(lte(attempts.expiresAt, now));
  }
}
