import type { Schedule as ScheduleView } from "@vibe/contracts";
import type { Caller } from "@vibe/identity";
import type { ChannelScope, UnitOfWork } from "@vibe/kernel";
import { actorFields, toActor, wroteAs } from "@vibe/messaging";
import { and, asc, channelMatches, type Db, enlist, eq, gt, lte, or, schema } from "@vibe/store";

import type { ScheduleFilter, ScheduleQueries, ScheduleRepository } from "../application/ports.ts";
import { Schedule, type ScheduleSnapshot } from "../domain/schedule.ts";

const { actors, schedules } = schema;

export class DrizzleScheduleRepository implements ScheduleRepository {
  constructor(private readonly db: Db) {}

  async find(vibeId: string, id: string): Promise<Schedule | null> {
    const row = await this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.vibeId, vibeId)))
      .get();
    return row ? Schedule.rehydrate(row) : null;
  }

  async due(now: number, limit: number): Promise<Schedule[]> {
    const rows = await this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.state, "pending"), lte(schedules.nextAt, now)))
      .orderBy(asc(schedules.nextAt))
      .limit(limit);
    return rows.map((row) => Schedule.rehydrate(row));
  }

  add(uow: UnitOfWork, schedule: Schedule): void {
    enlist(uow).add(this.db.insert(schedules).values(toRow(schedule.snapshot)));
  }

  save(uow: UnitOfWork, schedule: Schedule, was: ScheduleSnapshot): void {
    const now = schedule.snapshot;
    enlist(uow).add(
      this.db
        .update(schedules)
        .set({
          state: now.state,
          nextAt: now.nextAt,
          remaining: now.remaining,
          runs: now.runs,
          lastRunAt: now.lastRunAt,
          lastMessageId: now.lastMessageId,
          reason: now.reason,
          updatedAt: now.updatedAt,
        })
        // The guard: nothing is written over a firing or a cancel that landed since the read.
        .where(
          and(
            eq(schedules.id, now.id),
            eq(schedules.state, "pending"),
            eq(schedules.runs, was.runs),
          ),
        ),
    );
  }
}

function toRow(snapshot: ScheduleSnapshot): typeof schedules.$inferInsert {
  return {
    ...snapshot,
    labels: { ...snapshot.labels },
    blocks: snapshot.blocks.map((block) => ({ schema: block.schema, data: { ...block.data } })),
  };
}

const FILTERED_PAGE = 100;

export class DrizzleScheduleQueries implements ScheduleQueries {
  constructor(private readonly db: Db) {}

  /**
   * Access is decided in the domain, not in SQL: pages are read by the other
   * filters and what the reader can't see is dropped, until enough are left
   * or none remain.
   */
  async list(
    vibeId: string,
    filter: ScheduleFilter,
    scope: ChannelScope,
    reader: Caller,
  ): Promise<ScheduleView[]> {
    const visible: ScheduleView[] = [];
    const size = scope.all ? filter.limit : Math.max(filter.limit, FILTERED_PAGE);
    let after: { createdAt: number; id: string } | undefined;
    for (;;) {
      const rows = await this.db
        .select({ schedule: schedules, by: actorFields(actors) })
        .from(schedules)
        .innerJoin(actors, eq(actors.id, schedules.actorId))
        .where(
          and(
            eq(schedules.vibeId, vibeId),
            filter.all === true ? undefined : eq(schedules.state, "pending"),
            channelMatches(schedules.channel, filter.channel),
            filter.threadId === undefined ? undefined : eq(schedules.threadId, filter.threadId),
            filter.by === undefined ? undefined : wroteAs(actors, filter.by),
            after === undefined
              ? undefined
              : or(
                  gt(schedules.createdAt, after.createdAt),
                  and(eq(schedules.createdAt, after.createdAt), gt(schedules.id, after.id)),
                ),
          ),
        )
        .orderBy(asc(schedules.createdAt), asc(schedules.id))
        .limit(size);

      for (const row of rows) {
        // A reader under a limit sees what the limit lets it read, its principal's own included.
        const mine = row.schedule.principal === reader.principal && reader.narrowed === null;
        if (mine || scope.allows(row.schedule.channel)) {
          visible.push(toView(row.schedule, toActor(row.by)));
        }
        if (visible.length === filter.limit) return visible;
      }
      const last = rows[rows.length - 1];
      if (rows.length < size || !last) return visible;
      after = { createdAt: last.schedule.createdAt, id: last.schedule.id };
    }
  }

  async get(vibeId: string, id: string): Promise<ScheduleView | null> {
    const row = await this.db
      .select({ schedule: schedules, by: actorFields(actors) })
      .from(schedules)
      .innerJoin(actors, eq(actors.id, schedules.actorId))
      .where(and(eq(schedules.id, id), eq(schedules.vibeId, vibeId)))
      .get();
    return row ? toView(row.schedule, toActor(row.by)) : null;
  }
}

const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());

function toView(row: typeof schedules.$inferSelect, by: ScheduleView["by"]): ScheduleView {
  return {
    id: row.id,
    channel: row.channel,
    re: row.threadId,
    text: row.text,
    labels: row.labels,
    blocks: row.blocks,
    by,
    state: row.state,
    nextAt: row.state === "pending" ? iso(row.nextAt) : null,
    every: row.every === null ? null : row.every / 1000,
    until: iso(row.until),
    remaining: row.remaining,
    runs: row.runs,
    lastRunAt: iso(row.lastRunAt),
    lastMessageId: row.lastMessageId,
    reason: row.reason,
    noSync: row.noSync,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
