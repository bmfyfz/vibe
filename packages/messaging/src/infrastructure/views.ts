import type { Actor, Message } from "@vibe/contracts";
import { type AnySQLiteColumn, eq, isNull, or, type SQL, sql } from "@vibe/store";

type Column = AnySQLiteColumn;

/** The tables, or aliases of them, that a message's view is read from. */
export interface MessageSource {
  message: Record<
    | "id"
    | "text"
    | "threadId"
    | "replyTo"
    | "revision"
    | "deletedAt"
    | "createdAt"
    | "blocks"
    | "source"
    | "noSync",
    Column
  >;
  author: ActorSource;
  thread: Record<"channel", Column>;
}

export type ActorSource = Record<"id" | "handle" | "name" | "principal" | "profile", Column>;

/**
 * The columns of a message's view. Every field is read as a plain SQL value,
 * nullable, so the same selection works under a left join: a message that
 * isn't there comes back with a `null` ID, and `toMessage` returns `null`.
 */
export function messageFields({ message, author, thread }: MessageSource) {
  return {
    id: sql<string | null>`${message.id}`,
    channel: sql<string | null>`${thread.channel}`,
    text: sql<string | null>`${message.text}`,
    threadId: sql<string | null>`${message.threadId}`,
    replyTo: sql<string | null>`${message.replyTo}`,
    revision: sql<number | null>`${message.revision}`,
    createdAt: sql<number | null>`${message.createdAt}`,
    deletedAt: sql<number | null>`${message.deletedAt}`,
    blocks: sql<string | null>`${message.blocks}`,
    source: sql<string | null>`${message.source}`,
    noSync: sql<number | null>`${message.noSync}`,
    attachments: sql<string | null>`(
      SELECT json_group_array(json_object(
        'id', file.id, 'name', file.name, 'type', file.type, 'size', file.size,
        'position', link.position))
      FROM message_attachments link
      JOIN attachments file ON file.id = link.attachment_id
      WHERE link.message_id = ${message.id})`,
    labels: sql<string | null>`(
      SELECT json_group_object(label.key, label.value) FROM message_labels label
      WHERE label.message_id = ${message.id})`,
    mentions: sql<string | null>`(
      SELECT json_group_array(json_object(
        'actor', mentioned.id, 'handle', mentioned.handle, 'name', mentioned.name,
        'order', mention.rowid))
      FROM mentions mention
      JOIN actors mentioned ON mentioned.id = mention.actor_id
      WHERE mention.message_id = ${message.id})`,
    reactions: sql<string | null>`(
      SELECT json_group_array(json_object(
        'emoji', reaction.emoji, 'actor', reaction.actor_id, 'handle', reactor.handle,
        'order', reaction.rowid))
      FROM reactions reaction
      JOIN actors reactor ON reactor.id = reaction.actor_id
      WHERE reaction.message_id = ${message.id})`,
    ...actorFields(author),
  };
}

export function actorFields(author: ActorSource) {
  return {
    actor: sql<string | null>`${author.id}`,
    handle: sql<string | null>`${author.handle}`,
    name: sql<string | null>`${author.name}`,
    principal: sql<string | null>`${author.principal}`,
    profile: sql<string | null>`${author.profile}`,
  };
}

type RowOf<Fields> = {
  [Key in keyof Fields]: Fields[Key] extends { _: { type: infer T } } ? T : never;
};
export type MessageRow = RowOf<ReturnType<typeof messageFields>>;
export type ActorRow = RowOf<ReturnType<typeof actorFields>>;

/** What a message's `from` says when it was written on the vibe, and what `--source` takes for that. */
export const WRITTEN_HERE = "vibe";

export function toActor(row: ActorRow): Actor {
  return {
    actor: row.actor ?? "",
    handle: row.handle ?? "",
    name: row.name ?? "",
    principal: row.principal ?? "",
    profile: row.profile,
  };
}

export function toMessage(row: MessageRow): Message | null {
  if (row.id === null) return null;
  const files = JSON.parse(row.attachments ?? "[]") as {
    id: string;
    name: string;
    type: string;
    size: number;
    position: number;
  }[];
  return {
    id: row.id,
    channel: row.channel ?? "",
    text: row.text ?? "",
    re: row.threadId === row.id ? null : row.threadId,
    replyTo: row.replyTo,
    by: toActor(row),
    from: row.source ?? WRITTEN_HERE,
    noSync: row.noSync === 1,
    // A tombstone keeps the record of its files, and shows none of them.
    attachments:
      row.deletedAt === null
        ? files
            .sort((a, b) => a.position - b.position)
            .map(({ id, name, type, size }) => ({ id, name, type, size }))
        : [],
    blocks: JSON.parse(row.blocks ?? "[]") as Message["blocks"],
    labels: JSON.parse(row.labels ?? "{}") as Record<string, string>,
    mentions: toMentions(row.mentions),
    reactions: toReactions(row.reactions),
    deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt).toISOString(),
    revision: row.revision ?? 1,
    createdAt: new Date(row.createdAt ?? 0).toISOString(),
  };
}

/** Who a message mentions, in the order its text names them. */
function toMentions(json: string | null): Message["mentions"] {
  const rows = JSON.parse(json ?? "[]") as (Message["mentions"][number] & { order: number })[];
  return rows
    .sort((a, b) => a.order - b.order)
    .map(({ actor, handle, name }) => ({ actor, handle, name }));
}

/** Groups reactions by emoji, in the order each emoji was first used. */
function toReactions(json: string | null): Message["reactions"] {
  const rows = JSON.parse(json ?? "[]") as {
    emoji: string;
    actor: string;
    handle: string;
    order: number;
  }[];
  const byEmoji = new Map<string, Message["reactions"][number]>();
  for (const row of rows.sort((a, b) => a.order - b.order)) {
    const reaction = byEmoji.get(row.emoji) ?? { emoji: row.emoji, by: [] };
    reaction.by.push({ actor: row.actor, handle: row.handle });
    byEmoji.set(row.emoji, reaction);
  }
  return [...byEmoji.values()];
}

/**
 * The condition that an author is who a `by` filter names: a handle or an
 * actor ID. A person's handle covers their profiles, whose handles start with
 * it. With `=` in front, it is that one actor and no profile of theirs:
 * `=ada` is ada herself, where `ada` is ada and every agent that writes
 * through her. An agent waiting for its person's answer needs the first.
 */
export function wroteAs(author: ActorSource, by: string): SQL | undefined {
  if (by.startsWith(EXACTLY)) {
    const one = by.slice(EXACTLY.length);
    return or(eq(author.id, one), eq(author.handle, one));
  }
  return or(
    eq(author.id, by),
    eq(author.handle, by),
    sql`${author.principal} IN (
      SELECT person.id FROM actors person
      WHERE person.handle = ${by} AND person.profile IS NULL)`,
  );
}

/** What a `by` filter starts with to name one actor alone. */
const EXACTLY = "=";

/**
 * The condition that a message came from where a `source` filter names: a
 * sync entry's key, or `vibe` for a message written on the vibe itself.
 */
export function cameFrom(source: Column, named: string): SQL {
  return named === WRITTEN_HERE ? isNull(source) : eq(source, named);
}
