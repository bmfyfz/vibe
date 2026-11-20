import {
  BOOKKEEPING_EVENTS,
  ConstraintViolation,
  type EventLog,
  type EventRecord,
  type LabelFilter,
  type UnitOfWork,
} from "@vibe/kernel";
import { actorFields, cameFrom, messageFields, toActor, toMessage, wroteAs } from "@vibe/messaging";
import {
  alias,
  and,
  asc,
  channelMatches,
  type Db,
  enlist,
  eq,
  gt,
  inArray,
  lte,
  max,
  or,
  schema,
  type SQL,
  sql,
} from "@vibe/store";

import type {
  CurrentScope,
  EventFeed,
  EventFilter,
  Hub,
  StoredEvent,
} from "../application/ports.ts";

const { actors, events, messages, threads } = schema;

const FILTERED_PAGE = 100;

/** The event log on SQLite: one ordered table for every change to every vibe. */
export class DrizzleEventLog implements EventLog, EventFeed {
  constructor(
    private readonly db: Db,
    /** Told how far each vibe's log got, once a commit that appended to it has landed. */
    private readonly hub?: Hub | undefined,
  ) {}

  append(uow: UnitOfWork, records: readonly EventRecord[]): void {
    const work = enlist(uow);
    const { hub } = this;
    if (!hub) {
      for (const record of records) work.add(this.db.insert(events).values(record));
      return;
    }

    // The last event a commit appends to a vibe says how far that vibe's log
    // got. Its insert returns the place it was given, at no extra query.
    const last = new Map(records.map((record, index) => [record.vibeId, index]));
    for (const [index, record] of records.entries()) {
      const insert = this.db.insert(events).values(record);
      if (last.get(record.vibeId) !== index) {
        work.add(insert);
        continue;
      }
      let seq: number | undefined;
      work.addReturning<{ seq: number }>(insert.returning({ seq: events.seq }), (rows) => {
        seq = rows[0]?.seq;
      });
      work.onCommitted(() => {
        if (seq !== undefined) hub.poke(record.vibeId, seq);
      });
    }
  }

  isVersionConflict(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("events");
  }

  async head(vibeId: string): Promise<number> {
    const row = await this.db
      .select({ head: max(events.seq) })
      .from(events)
      .where(eq(events.vibeId, vibeId))
      .get();
    return row?.head ?? 0;
  }

  async seqOfMessage(
    vibeId: string,
    messageId: string,
  ): Promise<{ seq: number; channel: string } | null> {
    const row = await this.db
      .select({ seq: events.seq, channel: events.channel })
      .from(events)
      .where(
        and(
          eq(events.messageId, messageId),
          eq(events.vibeId, vibeId),
          eq(events.type, "message.posted"),
        ),
      )
      .get();
    return row && row.channel !== null ? { seq: row.seq, channel: row.channel } : null;
  }

  /**
   * Access is decided in the domain, not in SQL: pages are read by the other
   * filters, and what the caller can't read is dropped from each, until enough
   * events are left or the range is exhausted. Stopping early would let a
   * cursor move past events that were never looked at.
   *
   * The scope is read after each page, not before. Read before, it could miss
   * a grant made just ahead of an event in the page: the event would be
   * dropped, the cursor would pass it, and its reader would never see it. Read
   * after, it has every grant those events were written under, and a channel
   * made private a moment ago is already closed.
   */
  async read(
    vibeId: string,
    range: { afterSeq: number; uptoSeq?: number },
    filter: EventFilter,
    limit: number,
    currentScope: CurrentScope,
  ): Promise<StoredEvent[]> {
    const visible: StoredEvent[] = [];
    let size = limit;
    let afterSeq = range.afterSeq;
    for (;;) {
      const page = await this.page(vibeId, { ...range, afterSeq }, filter, size);
      const last = page[page.length - 1];
      if (!last) return visible;

      const scope = await currentScope();
      for (const event of page) {
        const readable = event.channel === null ? scope.all : scope.allows(event.channel);
        if (readable) visible.push(event);
        if (visible.length === limit) return visible;
      }
      if (page.length < size) return visible;
      afterSeq = last.seq;
      // Some were dropped, so read more at a time than was asked for: a wait
      // asks for one event, and shouldn't pay a query for each it can't see.
      size = Math.max(limit, FILTERED_PAGE);
    }
  }

  private async page(
    vibeId: string,
    range: { afterSeq: number; uptoSeq?: number },
    filter: EventFilter,
    limit: number,
  ): Promise<StoredEvent[]> {
    const author = alias(actors, "author");
    const causedBy = alias(actors, "caused_by");

    const rows = await this.db
      .select({
        seq: events.seq,
        type: events.type,
        channel: events.channel,
        createdAt: events.createdAt,
        payload: events.payload,
        actor: actorFields(causedBy),
        message: messageFields({ message: messages, author, thread: threads }),
      })
      .from(events)
      .innerJoin(causedBy, eq(causedBy.id, events.actorId))
      .leftJoin(messages, eq(messages.id, events.messageId))
      .leftJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(author, eq(author.id, messages.actorId))
      .where(
        and(
          eq(events.vibeId, vibeId),
          gt(events.seq, range.afterSeq),
          range.uptoSeq === undefined ? undefined : lte(events.seq, range.uptoSeq),
          filter.all === true ? undefined : notBookkeeping(),
          channelMatches(events.channel, filter.channel),
          filter.re === undefined ? undefined : eq(events.threadId, filter.re),
          filter.by === undefined ? undefined : wroteAs(author, filter.by),
          filter.source === undefined ? undefined : cameFrom(messages.source, filter.source),
          matchesBeforeOrAfter(filter),
        ),
      )
      .orderBy(asc(events.seq))
      .limit(limit);

    return rows.map((row) => ({
      seq: row.seq,
      channel: row.channel,
      type: row.type,
      createdAt: row.createdAt,
      payload: row.payload,
      actor: toActor(row.actor),
      message: toMessage(row.message),
    }));
  }
}

/**
 * The condition that an event's message matched the filters on what a change
 * can alter, either as the change left it or as it stood before. Both sides are
 * read from the snapshot the event carries, so an old event matches the same
 * way however its message has changed since.
 */
function matchesBeforeOrAfter(filter: EventFilter): SQL | undefined {
  const after = matchesState(filter, "$");
  if (after === undefined) return undefined;
  const either = or(after, matchesState(filter, "$.was"));
  if (filter.mentions === undefined) return either;
  // A mention is made, moved or taken back where text changes: by a post, an
  // edit, a deletion. What else happens to a message that mentions someone, a
  // reaction, its task changing hands, mentions them no further. Without this
  // a wait for mentions returns each time a task whose text names its reader
  // changes state. A label is the one other thing a filter can ask for, so a
  // filter that names one sees labels change too.
  const labeled = (filter.labels ?? []).length > 0;
  return and(either, labeled ? inArray(events.type, [...TEXT, "labels.changed"]) : changesText);
}

/** The events that change what a message says, and so whom it mentions. */
const TEXT = ["message.posted", "message.edited", "message.deleted"];
const changesText = inArray(events.type, TEXT);

function matchesState(filter: EventFilter, at: "$" | "$.was"): SQL | undefined {
  const conditions = (filter.labels ?? []).map((label) => hasLabel(label, at));
  if (filter.mentions !== undefined) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM json_each(${events.facets}, ${`${at}.mentions`}) mentioned
      WHERE mentioned.value = ${filter.mentions})`);
  }
  return conditions.length === 0 ? undefined : and(...conditions);
}

function hasLabel(label: LabelFilter, at: string): SQL {
  // A key holds only lowercase letters, numbers, `_`, `.` and `-`, so it is
  // safe between the quotes of a JSON path.
  const path = `${at}.labels."${label.key}"`;
  if (label.values === null) return sql`json_type(${events.facets}, ${path}) IS NOT NULL`;
  return sql`EXISTS (
    SELECT 1 FROM json_each(${events.facets}, ${path}) held
    WHERE held.value IN ${[...label.values]})`;
}

function notBookkeeping(): SQL {
  const hidden = sql.join(
    BOOKKEEPING_EVENTS.map((type) => sql`${type}`),
    sql`, `,
  );
  return sql`${events.type} NOT IN (${hidden})`;
}
