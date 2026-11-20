import { ConstraintViolation, type UnitOfWork } from "@vibe/kernel";
import {
  and,
  asc,
  count,
  type Db,
  desc,
  enlist,
  eq,
  isNull,
  lte,
  or,
  schema,
  sql,
} from "@vibe/store";

import type {
  Copy,
  CursorRepository,
  Inbox,
  KnownActor,
  PlacedCopy,
  PlatformActors,
  ReceivedEvent,
  SourceRepository,
  StoredSource,
  SyncedThread,
  SyncRecords,
  ThreadOutline,
  ThreadReader,
} from "../application/ports.ts";
import type { Source } from "../domain/source.ts";

const {
  actors,
  messages,
  syncCursors,
  syncInbox,
  syncMessages,
  syncSources,
  syncThreads,
  threads,
} = schema;

type SourceRow = typeof syncSources.$inferSelect;

function toSource(row: SourceRow): StoredSource {
  const { credentials, ...source } = row;
  return { ...source, sealed: credentials };
}

export class DrizzleSourceRepository implements SourceRepository {
  constructor(private readonly db: Db) {}

  async find(vibeId: string, key: string): Promise<StoredSource | null> {
    const row = await this.db
      .select()
      .from(syncSources)
      .where(and(eq(syncSources.vibeId, vibeId), eq(syncSources.key, key)))
      .get();
    return row ? toSource(row) : null;
  }

  async byId(id: string): Promise<StoredSource | null> {
    const row = await this.db.select().from(syncSources).where(eq(syncSources.id, id)).get();
    return row ? toSource(row) : null;
  }

  async count(vibeId: string): Promise<number> {
    const row = await this.db
      .select({ n: count() })
      .from(syncSources)
      .where(eq(syncSources.vibeId, vibeId))
      .get();
    return row?.n ?? 0;
  }

  async active(vibeId: string): Promise<StoredSource[]> {
    const rows = await this.db
      .select()
      .from(syncSources)
      .where(and(eq(syncSources.vibeId, vibeId), eq(syncSources.state, "active")))
      .orderBy(asc(syncSources.createdAt));
    return rows.map(toSource);
  }

  async due(now: number, limit: number): Promise<StoredSource[]> {
    const rows = await this.db
      .select({ source: syncSources })
      .from(syncSources)
      .innerJoin(syncCursors, eq(syncCursors.sourceId, syncSources.id))
      .where(
        and(
          eq(syncSources.state, "active"),
          or(isNull(syncCursors.leasedUntil), lte(syncCursors.leasedUntil, now)),
          or(
            sql`${syncCursors.seq} < (
              SELECT max(written.seq) FROM events written
              WHERE written.vibe_id = ${syncSources.vibeId})`,
            sql`EXISTS (
              SELECT 1 FROM sync_messages due
              WHERE due.source_id = ${syncSources.id} AND due.state = 'pending'
                AND (due.retry_at IS NULL OR due.retry_at <= ${now}))`,
          ),
        ),
      )
      // The one that has waited longest first.
      .orderBy(asc(syncCursors.updatedAt))
      .limit(limit);
    return rows.map((row) => toSource(row.source));
  }

  add(uow: UnitOfWork, source: StoredSource, seq: number, now: number): void {
    const { sealed, config, ...row } = source;
    enlist(uow).add(
      this.db.insert(syncSources).values({
        ...row,
        credentials: sealed,
        config: {
          ...config,
          mappings: config.mappings.map((mapping) => ({ ...mapping })),
          self: { ...config.self },
        },
      }),
      this.db.insert(syncCursors).values({ sourceId: source.id, seq, updatedAt: now }),
    );
  }

  recredential(uow: UnitOfWork, source: StoredSource): void {
    const { config } = source;
    enlist(uow).add(
      this.db
        .update(syncSources)
        .set({
          credentials: source.sealed,
          config: {
            ...config,
            mappings: config.mappings.map((mapping) => ({ ...mapping })),
            self: { ...config.self },
          },
        })
        .where(eq(syncSources.id, source.id)),
    );
  }

  remove(uow: UnitOfWork, source: Source): void {
    enlist(uow).add(
      this.db.delete(syncMessages).where(eq(syncMessages.sourceId, source.id)),
      this.db.delete(syncThreads).where(eq(syncThreads.sourceId, source.id)),
      this.db.delete(syncInbox).where(eq(syncInbox.sourceId, source.id)),
      this.db.delete(syncCursors).where(eq(syncCursors.sourceId, source.id)),
      this.db.delete(syncSources).where(eq(syncSources.id, source.id)),
    );
  }

  async stop(sourceId: string, reason: string): Promise<void> {
    await this.db.batch([
      this.db
        .update(syncSources)
        .set({ state: "stopped", reason })
        .where(eq(syncSources.id, sourceId)),
      this.db
        .update(syncCursors)
        .set({ leasedUntil: null })
        .where(eq(syncCursors.sourceId, sourceId)),
    ]);
  }
}

export class DrizzleCursorRepository implements CursorRepository {
  constructor(private readonly db: Db) {}

  async lease(sourceId: string, now: number, until: number): Promise<{ seq: number } | null> {
    // One statement decides who holds the entry: of two passes that ask at
    // once, the second finds it held and changes nothing.
    const rows = await this.db
      .update(syncCursors)
      .set({ leasedUntil: until })
      .where(
        and(
          eq(syncCursors.sourceId, sourceId),
          or(isNull(syncCursors.leasedUntil), lte(syncCursors.leasedUntil, now)),
        ),
      )
      .returning({ seq: syncCursors.seq });
    return rows[0] ?? null;
  }

  async renew(sourceId: string, held: number, until: number): Promise<boolean> {
    const rows = await this.db
      .update(syncCursors)
      .set({ leasedUntil: until })
      // The guard: only the pass whose hold this is keeps it.
      .where(and(eq(syncCursors.sourceId, sourceId), eq(syncCursors.leasedUntil, held)))
      .returning({ seq: syncCursors.seq });
    return rows.length > 0;
  }

  advance(uow: UnitOfWork, sourceId: string, from: number, to: number, now: number): void {
    enlist(uow).add(
      this.db
        .update(syncCursors)
        .set({ seq: to, updatedAt: now })
        .where(and(eq(syncCursors.sourceId, sourceId), eq(syncCursors.seq, from))),
    );
  }

  async release(sourceId: string, held: number, now: number): Promise<void> {
    await this.db
      .update(syncCursors)
      .set({ leasedUntil: null, updatedAt: now })
      .where(and(eq(syncCursors.sourceId, sourceId), eq(syncCursors.leasedUntil, held)));
  }
}

export class DrizzleSyncRecords implements SyncRecords {
  constructor(private readonly db: Db) {}

  async threadsOf(sourceId: string, threadId: string): Promise<SyncedThread[]> {
    return this.db
      .select()
      .from(syncThreads)
      .where(
        and(
          eq(syncThreads.sourceId, sourceId),
          eq(syncThreads.threadId, threadId),
          eq(syncThreads.state, "active"),
        ),
      )
      .orderBy(asc(syncThreads.createdAt));
  }

  async joins(vibeId: string, threadId: string): Promise<SyncedThread[]> {
    return this.db
      .select()
      .from(syncThreads)
      .where(and(eq(syncThreads.vibeId, vibeId), eq(syncThreads.threadId, threadId)))
      .orderBy(asc(syncThreads.createdAt));
  }

  async threadByPlatform(sourceId: string, platformThread: string): Promise<SyncedThread | null> {
    const row = await this.db
      .select()
      .from(syncThreads)
      .where(
        and(eq(syncThreads.sourceId, sourceId), eq(syncThreads.platformThread, platformThread)),
      )
      .get();
    return row ?? null;
  }

  async copyByPlatform(sourceId: string, platformMessage: string): Promise<PlacedCopy | null> {
    const [row] = await this.placed(
      and(eq(syncMessages.sourceId, sourceId), eq(syncMessages.platformMessage, platformMessage)),
      1,
    );
    return row ?? null;
  }

  copiesOf(sourceId: string, messageId: string): Promise<PlacedCopy[]> {
    return this.placed(
      and(eq(syncMessages.sourceId, sourceId), eq(syncMessages.messageId, messageId)),
      100,
    );
  }

  due(sourceId: string, now: number, limit: number): Promise<PlacedCopy[]> {
    return this.placed(
      and(
        eq(syncMessages.sourceId, sourceId),
        eq(syncMessages.state, "pending"),
        or(isNull(syncMessages.retryAt), lte(syncMessages.retryAt, now)),
        // A copy whose thread is not on the platform yet, and whose thread's
        // first copy waits for its next attempt, has nothing to be sent into.
        // Left out, it doesn't fill the pass ahead of what can go.
        sql`NOT EXISTS (
          SELECT 1 FROM sync_messages first
          WHERE first.sync_thread_id = ${syncMessages.syncThreadId}
            AND first.state = 'pending' AND first.retry_at > ${now}
            AND first.seq < ${syncMessages.seq}
            AND (${syncThreads.platformThread} IS NULL
              OR ${syncThreads.platformThread} = first.platform_message))`,
      ),
      limit,
    );
  }

  async current(copy: Copy): Promise<PlacedCopy | null> {
    const [row] = await this.placed(this.is(copy), 1);
    return row ?? null;
  }

  async starting(syncThreadId: string, rootId: string): Promise<boolean> {
    const row = await this.db
      .select({ state: syncMessages.state })
      .from(syncMessages)
      .where(and(eq(syncMessages.syncThreadId, syncThreadId), eq(syncMessages.messageId, rootId)))
      .get();
    return row?.state === "pending";
  }

  addThread(uow: UnitOfWork, thread: SyncedThread): void {
    enlist(uow).add(this.db.insert(syncThreads).values(thread));
  }

  addCopy(uow: UnitOfWork, copy: Copy): void {
    enlist(uow).add(this.db.insert(syncMessages).values(copy));
  }

  planCopy(uow: UnitOfWork, copy: Copy): void {
    enlist(uow).add(
      this.db
        .insert(syncMessages)
        .values(copy)
        .onConflictDoNothing({ target: [syncMessages.syncThreadId, syncMessages.messageId] }),
    );
  }

  async intend(copy: PlacedCopy, platformMessage: string, start: boolean): Promise<void> {
    const mine = this.db.update(syncMessages).set({ platformMessage }).where(this.is(copy));
    if (!start) {
      await mine;
      return;
    }
    await this.db.batch([
      mine,
      this.db
        .update(syncThreads)
        .set({ platformThread: platformMessage })
        .where(eq(syncThreads.id, copy.syncThreadId)),
    ]);
  }

  async started(
    copy: PlacedCopy,
    sent: { thread: string; message: string; url: string | null },
    now: number,
  ): Promise<void> {
    await this.db.batch([
      this.db
        .update(syncThreads)
        .set({ platformThread: sent.thread, url: sent.url })
        .where(eq(syncThreads.id, copy.syncThreadId)),
      this.settled(copy, sent, now),
    ]);
  }

  async delivered(
    copy: PlacedCopy,
    sent: { message: string; url: string | null },
    now: number,
  ): Promise<void> {
    await this.settled(copy, sent, now);
  }

  async retry(
    copy: PlacedCopy,
    attempts: number,
    retryAt: number,
    error: string,
    now: number,
  ): Promise<void> {
    await this.db
      .update(syncMessages)
      .set({ attempts, retryAt, lastError: error, updatedAt: now })
      .where(this.is(copy));
  }

  async failed(
    copy: PlacedCopy,
    attempts: number,
    error: string,
    now: number,
    thread: boolean,
  ): Promise<void> {
    const mine = this.db
      .update(syncMessages)
      .set({ state: "failed", attempts, retryAt: null, lastError: error, updatedAt: now })
      .where(this.is(copy));
    if (!thread) {
      await mine;
      return;
    }
    await this.db.batch([
      mine,
      this.db
        .update(syncThreads)
        .set({ state: "failed" })
        .where(eq(syncThreads.id, copy.syncThreadId)),
    ]);
  }

  async skip(copy: PlacedCopy, now: number): Promise<void> {
    await this.db
      .update(syncMessages)
      .set({ state: "skipped", retryAt: null, updatedAt: now })
      .where(this.is(copy));
  }

  isTaken(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("sync_threads");
  }

  isDuplicate(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("sync_messages");
  }

  private is(copy: Copy) {
    return and(
      eq(syncMessages.syncThreadId, copy.syncThreadId),
      eq(syncMessages.messageId, copy.messageId),
    );
  }

  private settled(copy: Copy, sent: { message: string; url: string | null }, now: number) {
    return this.db
      .update(syncMessages)
      .set({
        state: "done",
        platformMessage: sent.message,
        url: sent.url,
        retryAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(this.is(copy));
  }

  private async placed(where: ReturnType<typeof and>, limit: number): Promise<PlacedCopy[]> {
    const rows = await this.db
      .select({ copy: syncMessages, thread: syncThreads })
      .from(syncMessages)
      .innerJoin(syncThreads, eq(syncThreads.id, syncMessages.syncThreadId))
      .where(where)
      // In the order their messages were posted, and within one message, the
      // order its threads were joined.
      .orderBy(asc(syncMessages.seq), asc(syncMessages.createdAt), asc(syncThreads.id))
      .limit(limit);
    return rows.map((row) => ({ ...row.copy, thread: row.thread }));
  }
}

// An entry keeps this many of the events it received, the newest.
const INBOX_KEPT = 200;
// A body longer than this is cut. GitHub's can run to megabytes.
const MAX_BODY = 32_000;

export class DrizzleInbox implements Inbox {
  constructor(private readonly db: Db) {}

  async receive(event: ReceivedEvent): Promise<boolean> {
    const body = event.body.length > MAX_BODY ? `${event.body.slice(0, MAX_BODY)}…` : event.body;
    const inserted = await this.db
      .insert(syncInbox)
      .values({ ...event, body, state: "received" })
      .onConflictDoNothing()
      .returning({ deliveryId: syncInbox.deliveryId });
    if (inserted.length > 0) {
      await this.prune(event.sourceId);
      return true;
    }
    const earlier = await this.db
      .select({ state: syncInbox.state })
      .from(syncInbox)
      .where(
        and(eq(syncInbox.sourceId, event.sourceId), eq(syncInbox.deliveryId, event.deliveryId)),
      )
      .get();
    // One that failed, or was cut off before it was dealt with, is taken up again.
    return earlier?.state === "failed" || earlier?.state === "received";
  }

  async settle(
    sourceId: string,
    deliveryId: string,
    state: "done" | "ignored" | "failed",
    note: string | null,
  ): Promise<void> {
    await this.db
      .update(syncInbox)
      // What was not brought in is not kept either: an app is told of channels
      // that are mapped nowhere, and their words are nobody's to read here.
      .set(state === "ignored" ? { state, note, body: "" } : { state, note })
      .where(and(eq(syncInbox.sourceId, sourceId), eq(syncInbox.deliveryId, deliveryId)));
  }

  async list(sourceId: string, limit: number) {
    const rows = await this.db
      .select()
      .from(syncInbox)
      .where(eq(syncInbox.sourceId, sourceId))
      .orderBy(desc(syncInbox.receivedAt), desc(sql`rowid`))
      .limit(limit);
    return rows.map((row) => ({
      id: row.deliveryId,
      event: row.event,
      state: row.state,
      note: row.note,
      receivedAt: new Date(row.receivedAt).toISOString(),
      body: parsed(row.body),
    }));
  }

  async writesInto(sourceId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ channel: threads.channel })
      .from(syncThreads)
      .innerJoin(threads, eq(threads.id, syncThreads.threadId))
      .where(eq(syncThreads.sourceId, sourceId));
    return rows.map((row) => row.channel);
  }

  private async prune(sourceId: string): Promise<void> {
    await this.db.run(sql`
      DELETE FROM sync_inbox
      WHERE source_id = ${sourceId} AND rowid NOT IN (
        SELECT rowid FROM sync_inbox WHERE source_id = ${sourceId}
        ORDER BY received_at DESC, rowid DESC LIMIT ${INBOX_KEPT})`);
  }
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export class DrizzlePlatformActors implements PlatformActors {
  constructor(private readonly db: Db) {}

  async find(actorId: string): Promise<KnownActor | null> {
    const row = await this.db
      .select({ id: actors.id, handle: actors.handle, name: actors.name })
      .from(actors)
      .where(eq(actors.id, actorId))
      .get();
    return row ?? null;
  }

  async ensure(
    actor: {
      id: string;
      teamId: string;
      principal: string;
      profile: string;
      name: string;
      handles: readonly string[];
    },
    now: number,
  ): Promise<KnownActor> {
    // The last resort is a handle made from nothing anyone else could have.
    const last = `${actor.handles[0]?.split("/")[0] ?? "user"}/u-${crypto.randomUUID().slice(0, 12)}`;
    for (const handle of [...actor.handles, last]) {
      // A handle someone has, or an actor that is already there, changes
      // nothing: the row that comes back says which it was.
      await this.db
        .insert(actors)
        .values({
          id: actor.id,
          teamId: actor.teamId,
          principal: actor.principal,
          profile: actor.profile,
          handle,
          name: actor.name,
          createdAt: now,
        })
        .onConflictDoNothing();
      const known = await this.find(actor.id);
      if (known) return known;
    }
    throw new Error(`No handle could be found for ${actor.id}.`);
  }
}

export class DrizzleThreadReader implements ThreadReader {
  constructor(private readonly db: Db) {}

  async outline(vibeId: string, messageId: string): Promise<ThreadOutline | null> {
    const target = await this.db
      .select({ threadId: messages.threadId, channel: threads.channel })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(and(eq(messages.id, messageId), eq(messages.vibeId, vibeId)))
      .get();
    if (!target) return null;

    const rows = await this.db
      .select({
        id: messages.id,
        noSync: messages.noSync,
        deletedAt: messages.deletedAt,
        seq: sql<number | null>`(
          SELECT posted.seq FROM events posted
          WHERE posted.message_id = ${messages.id} AND posted.type = 'message.posted')`,
      })
      .from(messages)
      .where(eq(messages.threadId, target.threadId))
      .orderBy(asc(messages.position));
    const root = rows.find((row) => row.id === target.threadId);
    return {
      id: target.threadId,
      channel: target.channel,
      noSync: root?.noSync === true,
      messages: rows.map((row) => ({
        id: row.id,
        seq: row.seq ?? 0,
        noSync: row.noSync,
        deleted: row.deletedAt !== null,
      })),
    };
  }
}
