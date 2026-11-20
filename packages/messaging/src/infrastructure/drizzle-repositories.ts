import type { Channel } from "@vibe/contracts";
import { type ChannelPath, ConstraintViolation, type UnitOfWork } from "@vibe/kernel";
import {
  alias,
  and,
  type AnySQLiteColumn,
  asc,
  channelMatches,
  type Db,
  type DrizzleUnitOfWork,
  enlist,
  eq,
  inArray,
  or,
  schema,
  sql,
} from "@vibe/store";

import type {
  AttachmentRecord,
  AttachmentRepository,
  ChannelRecord,
  ChannelRepository,
  IdempotencyEntry,
  IdempotencyStore,
  PlacedAttachment,
  SchemaRepository,
  ThreadRepository,
  VibeRecord,
  VibeRepository,
} from "../application/ports.ts";
import type { Block } from "../domain/block.ts";
import type { MessageState } from "../domain/message.ts";
import type { Schema, SchemaRef } from "../domain/schema.ts";
import { Thread, type ThreadEvent } from "../domain/thread.ts";

const {
  attachments,
  channels,
  idempotency,
  messageAttachments,
  mentions,
  messageLabels,
  messages,
  vibes,
  reactions,
  schemas,
  threads,
} = schema;

export class DrizzleVibeRepository implements VibeRepository {
  constructor(private readonly db: Db) {}

  async findByName(teamId: string, name: string): Promise<VibeRecord | null> {
    const row = await this.db
      .select()
      .from(vibes)
      .where(and(eq(vibes.teamId, teamId), eq(vibes.name, name)))
      .get();
    return row ?? null;
  }

  async findById(id: string): Promise<VibeRecord | null> {
    return (await this.db.select().from(vibes).where(eq(vibes.id, id)).get()) ?? null;
  }

  async addIfMissing(vibe: VibeRecord): Promise<void> {
    await this.db.insert(vibes).values(vibe).onConflictDoNothing();
  }

  list(teamId: string): Promise<VibeRecord[]> {
    return this.db.select().from(vibes).where(eq(vibes.teamId, teamId)).orderBy(asc(vibes.name));
  }
}

export class DrizzleChannelRepository implements ChannelRepository {
  constructor(private readonly db: Db) {}

  async find(vibeId: string, path: string): Promise<Channel | null> {
    const row = await this.db
      .select({ path: channels.path, createdAt: channels.createdAt })
      .from(channels)
      .where(and(eq(channels.vibeId, vibeId), eq(channels.path, path)))
      .get();
    return row ? { path: row.path, createdAt: new Date(row.createdAt).toISOString() } : null;
  }

  async existsAtOrUnder(vibeId: string, path: string): Promise<boolean> {
    const row = await this.db
      .select({ path: channels.path })
      .from(channels)
      .where(
        and(
          eq(channels.vibeId, vibeId),
          or(
            eq(channels.path, path),
            channelMatches(channels.path, { kind: "subtree", prefix: `${path}/` }),
          ),
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  add(uow: UnitOfWork, channel: ChannelRecord): void {
    enlist(uow).add(this.db.insert(channels).values(channel));
  }

  isTaken(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("channels");
  }
}

export class DrizzleThreadRepository implements ThreadRepository {
  constructor(private readonly db: Db) {}

  async findByMessage(vibeId: string, messageId: string): Promise<Thread | null> {
    const root = alias(messages, "root");
    // One statement, so the thread's version and the state decided from are
    // read at the same instant: a change after it bumps the version, and the
    // commit computed from this read fails.
    const row = await this.db
      .select({ thread: threads, target: stateFields(messages), root: stateFields(root) })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(root, eq(root.id, threads.id))
      .where(and(eq(messages.id, messageId), eq(threads.vibeId, vibeId)))
      .get();
    if (!row) return null;
    return Thread.rehydrate({ ...row.thread, channel: row.thread.channel as ChannelPath }, [
      toState(row.root),
      toState(row.target),
    ]);
  }

  save(uow: UnitOfWork, thread: Thread, events: readonly ThreadEvent[]): void {
    const work = enlist(uow);
    const state = thread.snapshot;

    if (thread.isNew) {
      work.add(
        // The first post creates the channel, so channels need no setup.
        this.db
          .insert(channels)
          .values({
            vibeId: state.vibeId,
            path: state.channel,
            createdBy: events[0]?.actorId ?? "",
            createdAt: state.createdAt,
          })
          .onConflictDoNothing(),
        this.db.insert(threads).values(state),
      );
    } else {
      work.add(
        this.db
          .update(threads)
          .set({
            version: state.version,
            replyCount: state.replyCount,
            lastMessageId: state.lastMessageId,
            lastActivityAt: state.lastActivityAt,
          })
          .where(eq(threads.id, state.id)),
      );
    }

    for (const event of events) this.apply(work, state.vibeId, event);
  }

  /** Brings the stored messages in line with one thing that happened. */
  private apply(work: DrizzleUnitOfWork, vibeId: string, event: ThreadEvent): void {
    const { db } = this;
    switch (event.type) {
      case "message.posted": {
        const { message } = event;
        work.add(
          db.insert(messages).values({
            id: message.id,
            threadId: message.threadId,
            vibeId,
            replyTo: message.replyTo,
            actorId: message.actorId,
            text: message.text,
            blocks: [...message.blocks],
            position: message.position,
            source: message.source,
            noSync: message.noSync,
            createdAt: message.createdAt,
          }),
        );
        if (message.attachmentIds.length > 0) {
          work.add(
            db.insert(messageAttachments).values(
              message.attachmentIds.map((attachmentId, position) => ({
                attachmentId,
                messageId: message.id,
                position,
              })),
            ),
          );
        }
        this.setLabels(work, event, message.labels);
        this.addMentions(work, event, message.mentions);
        return;
      }
      case "message.edited":
        work.add(
          db
            .update(messages)
            .set({ text: event.text, blocks: [...event.blocks], revision: event.revision })
            .where(eq(messages.id, event.messageId)),
          db.delete(mentions).where(eq(mentions.messageId, event.messageId)),
        );
        this.addMentions(work, event, event.mentions);
        return;
      case "message.deleted":
        // A tombstone keeps its place, its author and its files' records, and
        // nothing a reader or a filter could find it by.
        work.add(
          db
            .update(messages)
            .set({ text: "", blocks: [], revision: event.revision, deletedAt: event.at })
            .where(eq(messages.id, event.messageId)),
          db.delete(messageLabels).where(eq(messageLabels.messageId, event.messageId)),
          db.delete(mentions).where(eq(mentions.messageId, event.messageId)),
          db.delete(reactions).where(eq(reactions.messageId, event.messageId)),
        );
        return;
      case "reaction.added":
        work.add(
          db
            .insert(reactions)
            .values({
              messageId: event.messageId,
              emoji: event.emoji,
              actorId: event.actorId,
              createdAt: event.at,
            })
            .onConflictDoNothing(),
        );
        return;
      case "reaction.removed":
        work.add(
          db
            .delete(reactions)
            .where(
              and(
                eq(reactions.messageId, event.messageId),
                eq(reactions.emoji, event.emoji),
                eq(reactions.actorId, event.actorId),
              ),
            ),
        );
        return;
      case "labels.changed":
      case "thread.noted": {
        this.setLabels(work, event, event.set);
        if (event.unset.length > 0) {
          work.add(
            db
              .delete(messageLabels)
              .where(
                and(
                  eq(messageLabels.messageId, event.messageId),
                  inArray(messageLabels.key, [...event.unset]),
                ),
              ),
          );
        }
        return;
      }
    }
  }

  private setLabels(
    work: DrizzleUnitOfWork,
    event: ThreadEvent,
    labels: Readonly<Record<string, string>>,
  ): void {
    for (const [key, value] of Object.entries(labels)) {
      work.add(
        this.db
          .insert(messageLabels)
          .values({ messageId: event.messageId, threadId: event.threadId, key, value })
          .onConflictDoUpdate({
            target: [messageLabels.messageId, messageLabels.key],
            set: { value },
          }),
      );
    }
  }

  private addMentions(
    work: DrizzleUnitOfWork,
    event: ThreadEvent,
    actorIds: readonly string[],
  ): void {
    // Three bound parameters a row, and D1 takes at most 100 in a statement.
    for (let from = 0; from < actorIds.length; from += 30) {
      work.add(
        this.db.insert(mentions).values(
          actorIds.slice(from, from + 30).map((actorId) => ({
            messageId: event.messageId,
            actorId,
            threadId: event.threadId,
          })),
        ),
      );
    }
  }

  isAttachmentTaken(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("message_attachments");
  }
}

type StateSource = Record<
  "id" | "actorId" | "text" | "revision" | "deletedAt" | "blocks" | "source",
  AnySQLiteColumn
>;

/** What the aggregate needs to know of a message, read from the messages table or an alias of it. */
function stateFields(message: StateSource) {
  return {
    id: sql<string>`${message.id}`,
    actorId: sql<string>`${message.actorId}`,
    text: sql<string>`${message.text}`,
    revision: sql<number>`${message.revision}`,
    deletedAt: sql<number | null>`${message.deletedAt}`,
    source: sql<string | null>`${message.source}`,
    blocks: sql<string>`${message.blocks}`,
    attachmentCount: sql<number>`(
      SELECT count(*) FROM message_attachments link WHERE link.message_id = ${message.id})`,
    labels: sql<string>`(
      SELECT json_group_object(label.key, label.value) FROM message_labels label
      WHERE label.message_id = ${message.id})`,
    mentions: sql<string>`(
      SELECT json_group_array(mention.actor_id) FROM mentions mention
      WHERE mention.message_id = ${message.id})`,
    reactions: sql<string>`(
      SELECT json_group_array(json_object('emoji', reaction.emoji, 'actorId', reaction.actor_id))
      FROM reactions reaction WHERE reaction.message_id = ${message.id})`,
  };
}

type StateRow = {
  [Key in keyof ReturnType<typeof stateFields>]: ReturnType<typeof stateFields>[Key] extends {
    _: { type: infer T };
  }
    ? T
    : never;
};

function toState(row: StateRow): MessageState {
  return {
    id: row.id,
    actorId: row.actorId,
    text: row.text,
    revision: row.revision,
    deletedAt: row.deletedAt,
    source: row.source,
    attachmentCount: row.attachmentCount,
    blocks: JSON.parse(row.blocks) as Block[],
    labels: JSON.parse(row.labels) as Record<string, string>,
    mentions: JSON.parse(row.mentions) as string[],
    reactions: JSON.parse(row.reactions) as { emoji: string; actorId: string }[],
  };
}

// D1 takes at most 100 bound parameters in a statement.
const ATTACHMENTS_PER_STATEMENT = 90;

export class DrizzleAttachmentRepository implements AttachmentRepository {
  constructor(private readonly db: Db) {}

  async add(attachment: AttachmentRecord): Promise<void> {
    await this.db.insert(attachments).values(attachment);
  }

  async find(vibeId: string, id: string): Promise<PlacedAttachment | null> {
    const [found] = await this.findMany(vibeId, [id]);
    return found ?? null;
  }

  async findMany(vibeId: string, ids: readonly string[]): Promise<PlacedAttachment[]> {
    // A plan of tasks may carry more files than D1 takes parameters in one statement.
    const wanted = [...new Set(ids)];
    const rows = [];
    for (let from = 0; from < wanted.length; from += ATTACHMENTS_PER_STATEMENT) {
      rows.push(
        ...(await this.db
          .select({
            file: attachments,
            messageId: messageAttachments.messageId,
            channel: threads.channel,
            deletedAt: messages.deletedAt,
          })
          .from(attachments)
          .leftJoin(messageAttachments, eq(messageAttachments.attachmentId, attachments.id))
          .leftJoin(messages, eq(messages.id, messageAttachments.messageId))
          .leftJoin(threads, eq(threads.id, messages.threadId))
          .where(
            and(
              eq(attachments.vibeId, vibeId),
              inArray(attachments.id, wanted.slice(from, from + ATTACHMENTS_PER_STATEMENT)),
            ),
          )),
      );
    }
    return rows.map((row) => ({
      ...row.file,
      messageId: row.messageId,
      channel: row.channel,
      hidden: row.deletedAt !== null,
    }));
  }
}

export class DrizzleIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Db) {}

  async find(principal: string, key: string): Promise<IdempotencyEntry | null> {
    const row = await this.db
      .select()
      .from(idempotency)
      .where(and(eq(idempotency.principal, principal), eq(idempotency.key, key)))
      .get();
    return row ?? null;
  }

  record(uow: UnitOfWork, entry: IdempotencyEntry): void {
    enlist(uow).add(this.db.insert(idempotency).values(entry));
  }

  isDuplicate(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("idempotency");
  }
}

export class DrizzleSchemaRepository implements SchemaRepository {
  constructor(private readonly db: Db) {}

  async find(teamId: string, ref: SchemaRef): Promise<Schema | null> {
    const row = await this.db
      .select()
      .from(schemas)
      .where(
        and(
          eq(schemas.teamId, teamId),
          eq(schemas.name, ref.name),
          eq(schemas.version, ref.version),
        ),
      )
      .get();
    return row ?? null;
  }

  list(teamId: string): Promise<Schema[]> {
    return this.db
      .select()
      .from(schemas)
      .where(eq(schemas.teamId, teamId))
      .orderBy(asc(schemas.name), asc(schemas.version));
  }

  add(uow: UnitOfWork, schema: Schema): void {
    enlist(uow).add(
      this.db.insert(schemas).values({ ...schema, definition: { ...schema.definition } }),
    );
  }

  isTaken(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("schemas");
  }
}
