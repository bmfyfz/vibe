import { encodeCursor } from "@vibe/activity";
import type { Watcher as WatcherView } from "@vibe/contracts";
import type { UnitOfWork } from "@vibe/kernel";
import { actorFields, toActor } from "@vibe/messaging";
import { and, asc, count, type Db, enlist, eq, isNull, lte, or, schema, sql } from "@vibe/store";

import type { DeliveryState, WatcherQueries, WatcherRepository } from "../application/ports.ts";
import type { Watcher } from "../domain/watcher.ts";

const { actors, watcherCursors, watchers } = schema;

export class DrizzleWatcherRepository implements WatcherRepository {
  constructor(private readonly db: Db) {}

  async find(vibeId: string, idOrName: string): Promise<Watcher | null> {
    const row = await this.db
      .select()
      .from(watchers)
      .where(
        and(
          eq(watchers.vibeId, vibeId),
          or(eq(watchers.id, idOrName), eq(watchers.name, idOrName)),
        ),
      )
      .get();
    return row ?? null;
  }

  async count(vibeId: string): Promise<number> {
    const row = await this.db
      .select({ n: count() })
      .from(watchers)
      .where(eq(watchers.vibeId, vibeId))
      .get();
    return row?.n ?? 0;
  }

  async active(vibeId: string): Promise<Watcher[]> {
    return this.db
      .select()
      .from(watchers)
      .where(and(eq(watchers.vibeId, vibeId), eq(watchers.state, "active")))
      .orderBy(asc(watchers.createdAt));
  }

  async due(now: number, limit: number): Promise<Watcher[]> {
    const rows = await this.db
      .select({ watcher: watchers })
      .from(watchers)
      .innerJoin(watcherCursors, eq(watcherCursors.watcherId, watchers.id))
      .where(
        and(
          eq(watchers.state, "active"),
          free(now),
          sql`${watcherCursors.seq} < (
            SELECT max(written.seq) FROM events written WHERE written.vibe_id = ${watchers.vibeId})`,
        ),
      )
      // The one that has waited longest first.
      .orderBy(asc(watcherCursors.updatedAt))
      .limit(limit);
    return rows.map((row) => row.watcher);
  }

  add(uow: UnitOfWork, watcher: Watcher, seq: number, now: number): void {
    enlist(uow).add(
      this.db.insert(watchers).values({
        ...watcher,
        tail: {
          ...watcher.tail,
          labels: [...watcher.tail.labels],
          source: watcher.tail.source ?? null,
        },
      }),
      this.db.insert(watcherCursors).values({ watcherId: watcher.id, seq, updatedAt: now }),
    );
  }

  remove(uow: UnitOfWork, watcher: Watcher): void {
    enlist(uow).add(
      this.db.delete(watcherCursors).where(eq(watcherCursors.watcherId, watcher.id)),
      this.db.delete(watchers).where(eq(watchers.id, watcher.id)),
    );
  }

  async lease(watcherId: string, now: number, until: number): Promise<DeliveryState | null> {
    // One statement decides who holds the watcher: of two passes that ask at
    // once, the second finds it held and changes nothing.
    const rows = await this.db
      .update(watcherCursors)
      .set({ leasedUntil: until })
      .where(and(eq(watcherCursors.watcherId, watcherId), free(now)))
      .returning({ seq: watcherCursors.seq, attempts: watcherCursors.attempts });
    return rows[0] ?? null;
  }

  async advance(
    watcherId: string,
    from: number,
    to: number,
    now: number,
    until: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(watcherCursors)
      .set({
        seq: to,
        attempts: 0,
        retryAt: null,
        lastStatus: null,
        lastError: null,
        deliveredAt: now,
        leasedUntil: until,
        updatedAt: now,
      })
      // The guard: only the pass that left the cursor here moves it on.
      .where(and(eq(watcherCursors.watcherId, watcherId), eq(watcherCursors.seq, from)))
      .returning({ seq: watcherCursors.seq });
    return rows.length > 0;
  }

  async settle(watcherId: string, from: number, to: number, now: number): Promise<void> {
    await this.db
      .update(watcherCursors)
      .set({ seq: to, leasedUntil: null, updatedAt: now })
      .where(and(eq(watcherCursors.watcherId, watcherId), eq(watcherCursors.seq, from)));
  }

  async failed(
    watcherId: string,
    from: number,
    failure: { attempts: number; retryAt: number; status: number | null; error: string },
    now: number,
  ): Promise<void> {
    await this.db
      .update(watcherCursors)
      .set({
        attempts: failure.attempts,
        retryAt: failure.retryAt,
        lastStatus: failure.status,
        lastError: failure.error,
        leasedUntil: null,
        updatedAt: now,
      })
      .where(and(eq(watcherCursors.watcherId, watcherId), eq(watcherCursors.seq, from)));
  }

  async stop(watcherId: string, reason: string): Promise<void> {
    await this.db.batch([
      this.db.update(watchers).set({ state: "stopped", reason }).where(eq(watchers.id, watcherId)),
      this.db
        .update(watcherCursors)
        .set({ leasedUntil: null })
        .where(eq(watcherCursors.watcherId, watcherId)),
    ]);
  }
}

/** The condition that no pass holds a watcher's deliveries and it isn't waiting out a failed attempt. */
function free(now: number) {
  return and(
    or(isNull(watcherCursors.leasedUntil), lte(watcherCursors.leasedUntil, now)),
    or(isNull(watcherCursors.retryAt), lte(watcherCursors.retryAt, now)),
  );
}

export class DrizzleWatcherQueries implements WatcherQueries {
  constructor(private readonly db: Db) {}

  async list(vibeId: string): Promise<WatcherView[]> {
    const rows = await this.rows(eq(watchers.vibeId, vibeId));
    return rows.map(toView);
  }

  async get(vibeId: string, id: string): Promise<WatcherView | null> {
    const [row] = await this.rows(and(eq(watchers.vibeId, vibeId), eq(watchers.id, id)));
    return row ? toView(row) : null;
  }

  private rows(where: ReturnType<typeof and>) {
    return this.db
      .select({ watcher: watchers, cursor: watcherCursors, by: actorFields(actors) })
      .from(watchers)
      .innerJoin(watcherCursors, eq(watcherCursors.watcherId, watchers.id))
      .innerJoin(actors, eq(actors.id, watchers.actorId))
      .where(where)
      .orderBy(asc(watchers.createdAt), asc(watchers.id));
  }
}

const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());

function toView(row: {
  watcher: typeof watchers.$inferSelect;
  cursor: typeof watcherCursors.$inferSelect;
  by: Parameters<typeof toActor>[0];
}): WatcherView {
  const { watcher, cursor } = row;
  const failing = watcher.state === "active" && cursor.attempts > 0;
  return {
    id: watcher.id,
    name: watcher.name,
    url: watcher.url,
    tail: { ...watcher.tail, source: watcher.tail.source ?? null },
    by: toActor(row.by),
    state: failing ? "failing" : watcher.state,
    reason: watcher.reason,
    cursor: encodeCursor(cursor.seq),
    attempts: cursor.attempts,
    retryAt: failing ? iso(cursor.retryAt) : null,
    lastStatus: cursor.lastStatus,
    lastError: cursor.lastError,
    deliveredAt: iso(cursor.deliveredAt),
    createdAt: new Date(watcher.createdAt).toISOString(),
  };
}
