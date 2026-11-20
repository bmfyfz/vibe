import type { Actor, Channel, Message, ThreadSummary } from "@vibe/contracts";
import type { ChannelScope } from "@vibe/kernel";
import {
  alias,
  and,
  asc,
  channelMatches,
  type Db,
  desc,
  eq,
  exists,
  gt,
  inArray,
  lt,
  or,
  schema,
  sql,
} from "@vibe/store";

import type { MessagingQueries, ThreadFilter } from "../application/ports.ts";
import { actorFields, cameFrom, messageFields, toActor, toMessage, wroteAs } from "./views.ts";

const { actors, channels, events, mentions, messageLabels, messages, threads } = schema;

export class DrizzleMessagingQueries implements MessagingQueries {
  constructor(private readonly db: Db) {}

  async listChannels(vibeId: string): Promise<Channel[]> {
    const rows = await this.db
      .select({ path: channels.path, createdAt: channels.createdAt })
      .from(channels)
      .where(eq(channels.vibeId, vibeId))
      .orderBy(asc(channels.path));
    return rows.map((row) => ({
      path: row.path,
      createdAt: new Date(row.createdAt).toISOString(),
    }));
  }

  /**
   * One summary per thread, most recently active first: its root, its reply
   * count, its latest reply. Access is decided in the domain, not in SQL, so a
   * caller who can't read every channel gets pages filtered here, and more
   * pages are read until enough threads are left or none remain.
   */
  async listThreads(
    vibeId: string,
    filter: ThreadFilter,
    scope: ChannelScope,
  ): Promise<ThreadSummary[]> {
    const visible: ThreadSummary[] = [];
    // When some will be dropped, read more at a time than was asked for.
    const size = scope.all ? filter.limit : Math.max(filter.limit, FILTERED_PAGE);
    let before: Place | undefined;
    for (;;) {
      const page = await this.threadsPage(vibeId, { ...filter, limit: size }, before);
      for (const row of page) {
        if (scope.allows(row.summary.message.channel)) visible.push(row.summary);
        if (visible.length === filter.limit) return visible;
      }
      const last = page[page.length - 1];
      if (page.length < size || !last) return visible;
      before = last.place;
    }
  }

  private async threadsPage(
    vibeId: string,
    filter: ThreadFilter,
    before: Place | undefined,
  ): Promise<{ summary: ThreadSummary; place: Place }[]> {
    const root = alias(messages, "root");
    const rootAuthor = alias(actors, "root_author");
    const last = alias(messages, "last");
    const lastAuthor = alias(actors, "last_author");

    const conditions = [
      eq(threads.vibeId, vibeId),
      channelMatches(threads.channel, filter.channel),
      before === undefined
        ? undefined
        : or(
            lt(threads.lastActivityAt, before.activityAt),
            and(eq(threads.lastActivityAt, before.activityAt), lt(threads.id, before.id)),
          ),
    ];
    if (filter.afterSeq !== undefined) {
      conditions.push(
        sql`${threads.id} IN (
          SELECT ${events.threadId} FROM ${events}
          WHERE ${events.vibeId} = ${vibeId} AND ${events.seq} > ${filter.afterSeq})`,
      );
    }
    for (const label of filter.labels ?? []) {
      conditions.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(messageLabels)
            .where(
              and(
                eq(messageLabels.threadId, threads.id),
                eq(messageLabels.key, label.key),
                label.values === null ? undefined : inArray(messageLabels.value, [...label.values]),
              ),
            ),
        ),
      );
    }
    if (filter.mentions !== undefined) {
      conditions.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(mentions)
            .where(and(eq(mentions.threadId, threads.id), eq(mentions.actorId, filter.mentions))),
        ),
      );
    }
    if (filter.source !== undefined) {
      const sent = alias(messages, "sent");
      conditions.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(sent)
            .where(and(eq(sent.threadId, threads.id), cameFrom(sent.source, filter.source))),
        ),
      );
    }
    if (filter.by !== undefined) {
      const written = alias(messages, "written");
      const writer = alias(actors, "writer");
      conditions.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(written)
            .innerJoin(writer, eq(writer.id, written.actorId))
            .where(and(eq(written.threadId, threads.id), wroteAs(writer, filter.by))),
        ),
      );
    }

    const rows = await this.db
      .select({
        replies: threads.replyCount,
        activityAt: threads.lastActivityAt,
        root: messageFields({ message: root, author: rootAuthor, thread: threads }),
        last: messageFields({ message: last, author: lastAuthor, thread: threads }),
      })
      .from(threads)
      .innerJoin(root, eq(root.id, threads.id))
      .innerJoin(rootAuthor, eq(rootAuthor.id, root.actorId))
      .leftJoin(last, and(eq(last.id, threads.lastMessageId), gt(threads.replyCount, 0)))
      .leftJoin(lastAuthor, eq(lastAuthor.id, last.actorId))
      .where(and(...conditions))
      .orderBy(desc(threads.lastActivityAt), desc(threads.id))
      .limit(filter.limit);

    const page: { summary: ThreadSummary; place: Place }[] = [];
    for (const row of rows) {
      const message = toMessage(row.root);
      if (!message) continue;
      page.push({
        summary: { message, replies: row.replies, last: toMessage(row.last) },
        place: { activityAt: row.activityAt, id: message.id },
      });
    }
    return page;
  }

  /** The whole thread, from any message in it. */
  async getThread(
    vibeId: string,
    messageId: string,
  ): Promise<{ message: Message; replies: Message[] } | null> {
    const target = await this.db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.vibeId, vibeId)))
      .get();
    if (!target) return null;

    const rows = await this.db
      .select(messageFields({ message: messages, author: actors, thread: threads }))
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(actors, eq(actors.id, messages.actorId))
      .where(eq(messages.threadId, target.threadId))
      .orderBy(asc(messages.position));

    const [message, ...replies] = rows.map(toMessage).filter((m): m is Message => m !== null);
    return message ? { message, replies } : null;
  }

  async getMessage(vibeId: string, messageId: string): Promise<Message | null> {
    const row = await this.db
      .select(messageFields({ message: messages, author: actors, thread: threads }))
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .innerJoin(actors, eq(actors.id, messages.actorId))
      .where(and(eq(messages.id, messageId), eq(messages.vibeId, vibeId)))
      .get();
    return row ? toMessage(row) : null;
  }

  async listActors(teamId: string): Promise<Actor[]> {
    const rows = await this.db
      .select(actorFields(actors))
      .from(actors)
      .where(eq(actors.teamId, teamId))
      .orderBy(asc(actors.handle));
    return rows.map(toActor);
  }

  async listAuthors(vibeId: string): Promise<{ actorId: string; channel: string }[]> {
    return this.db
      .selectDistinct({ actorId: messages.actorId, channel: threads.channel })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(eq(messages.vibeId, vibeId));
  }
}

const FILTERED_PAGE = 50;

/** Where a thread sits in the list, to continue after it. */
interface Place {
  activityAt: number;
  id: string;
}
