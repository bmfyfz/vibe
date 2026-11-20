import type { ChannelPath, EventFacets, MatchState } from "@vibe/kernel";

import { type Block, sameBlocks } from "./block.ts";
import { normalizeEmoji } from "./emoji.ts";
import {
  messageDeleted,
  messageNotFound,
  newerMessage,
  notAuthor,
  revisionConflict,
} from "./errors.ts";
import {
  type AppliedLabelChange,
  applyLabelChange,
  assertSettable,
  type LabelChange,
  type Labels,
  labelValue,
  RESERVED_LABEL_PREFIX,
} from "./label.ts";
import {
  assertContent,
  assertText,
  type Editor,
  type Message,
  type MessageState,
  wrote,
} from "./message.ts";

export interface ThreadState {
  /** The ID of the root message. */
  readonly id: string;
  readonly vibeId: string;
  readonly channel: ChannelPath;
  /** Bumped by every change. A commit is accepted only if nobody else has used its version. */
  readonly version: number;
  readonly replyCount: number;
  readonly lastMessageId: string;
  readonly lastActivityAt: number;
  readonly createdAt: number;
}

/** What every change in a thread records: where it sits in the thread's order, and who made it. */
interface Change {
  readonly threadId: string;
  /** The thread's version after the change. No two changes in a thread share one. */
  readonly threadVersion: number;
  readonly messageId: string;
  readonly actorId: string;
  readonly at: number;
  readonly facets: EventFacets | null;
}

export interface MessagePosted extends Change {
  readonly type: "message.posted";
  readonly message: Message;
}

export interface LabelsChanged extends Change {
  readonly type: "labels.changed";
  readonly set: Labels;
  readonly unset: readonly string[];
}

export interface MessageEdited extends Change {
  readonly type: "message.edited";
  readonly text: string;
  readonly mentions: readonly string[];
  /** The message's data as the edit left it. */
  readonly blocks: readonly Block[];
  readonly revision: number;
}

/** The message became a tombstone: its text, data, labels and reactions are gone, and its replies stay. */
export interface MessageDeleted extends Change {
  readonly type: "message.deleted";
  readonly revision: number;
}

export interface ReactionChanged extends Change {
  readonly type: "reaction.added" | "reaction.removed";
  readonly emoji: string;
}

/**
 * Something the vibe itself records on a thread, for another context that keeps
 * state there, such as a task's. It takes the thread's next version like every
 * other change, so it is ordered with them and guarded by the same lock.
 */
export interface ThreadNoted extends Change {
  readonly type: "thread.noted";
  /** What the change is called in the event log, such as `task.claimed`. */
  readonly as: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The vibe's own labels the change set on the root, and removed from it. */
  readonly set: Labels;
  readonly unset: readonly string[];
}

export type ThreadEvent =
  MessagePosted | MessageEdited | MessageDeleted | ReactionChanged | LabelsChanged | ThreadNoted;

type Unversioned<Event> = Event extends ThreadEvent
  ? Omit<Event, "threadId" | "threadVersion">
  : never;

interface NewMessage {
  id: string;
  actorId: string;
  text: string;
  attachmentIds?: readonly string[] | undefined;
  /** Structured data, already checked against the schemas it names. */
  blocks?: readonly Block[] | undefined;
  labels?: Labels | undefined;
  /** The actors the text mentions, already settled. */
  mentions?: readonly string[] | undefined;
  /** The sync entry it came in through, when it was written on another platform. */
  source?: string | null | undefined;
  /** Keep it off every synced platform. */
  noSync?: boolean | undefined;
  now: number;
}

/**
 * A root message and its replies, one level deep. The thread is the unit of
 * consistency: everything that happens in it, to any of its messages, is
 * ordered by its version.
 */
export class Thread {
  private pending: ThreadEvent[] = [];
  private readonly messages = new Map<string, MessageState>();

  private constructor(
    private state: ThreadState,
    /** Whether this thread has never been stored. */
    readonly isNew: boolean,
    messages: readonly MessageState[],
  ) {
    for (const message of messages) this.messages.set(message.id, message);
  }

  /** A post in a channel starts a thread. That message is the thread's root. */
  static start(input: NewMessage & { vibeId: string; channel: ChannelPath }): Thread {
    const thread = new Thread(
      {
        id: input.id,
        vibeId: input.vibeId,
        channel: input.channel,
        version: 0,
        replyCount: 0,
        lastMessageId: input.id,
        lastActivityAt: input.now,
        createdAt: input.now,
      },
      true,
      [],
    );
    thread.post(input, null);
    return thread;
  }

  /**
   * Restores a stored thread.
   *
   * @param messages The messages a change may concern: the thread's root, and
   *   the message the command names. The rest stay in the store.
   */
  static rehydrate(state: ThreadState, messages: readonly MessageState[]): Thread {
    return new Thread(state, false, messages);
  }

  /**
   * A reply to any message in the thread joins the thread.
   *
   * @param input.inReplyTo The message answered. It must be in this thread.
   * @param input.after When given, the reply lands only while this message is
   *   still the thread's newest.
   */
  reply(input: NewMessage & { inReplyTo: string; after?: string | undefined }): Message {
    if (input.after !== undefined && input.after !== this.state.lastMessageId) {
      throw newerMessage();
    }
    const message = this.post(input, input.inReplyTo === this.state.id ? null : input.inReplyTo);
    this.state = {
      ...this.state,
      replyCount: this.state.replyCount + 1,
      lastMessageId: input.id,
      lastActivityAt: input.now,
    };
    return message;
  }

  /**
   * Sets and removes labels on a message, when the change's conditions hold.
   *
   * @returns What changed. Nothing is recorded when the labels already were as asked.
   * @throws `label_conflict` when a condition doesn't hold. Nothing changes then.
   */
  label(input: {
    messageId: string;
    actorId: string;
    change: LabelChange;
    now: number;
  }): AppliedLabelChange {
    const message = this.live(input.messageId);
    const applied = applyLabelChange(message.labels, input.change);
    if (Object.keys(applied.set).length === 0 && applied.unset.length === 0) return applied;

    const was = this.matchState(message.id);
    this.messages.set(message.id, { ...message, labels: applied.labels });
    this.record({
      type: "labels.changed",
      messageId: message.id,
      actorId: input.actorId,
      at: input.now,
      set: applied.set,
      unset: applied.unset,
      facets: { ...this.matchState(message.id), was },
    });
    return applied;
  }

  /**
   * Replaces a message's text, its data, or both. What isn't given stays.
   *
   * @param input.mentions The actors the new text mentions. Goes with `text`.
   * @param input.revision When given, the edit lands only while the message is
   *   still at this revision.
   * @returns Whether anything changed. Writing what it already holds does nothing.
   * @throws `forbidden` unless the editor wrote it, and `revision_conflict`
   *   when someone changed it since `revision`.
   */
  edit(input: {
    messageId: string;
    by: Editor;
    text?: string | undefined;
    mentions?: readonly string[] | undefined;
    blocks?: readonly Block[] | undefined;
    revision?: number | undefined;
    now: number;
  }): boolean {
    const message = this.live(input.messageId);
    if (!wrote(message, input.by)) throw notAuthor();
    if (input.revision !== undefined && input.revision !== message.revision) {
      throw revisionConflict();
    }
    const text = input.text ?? message.text;
    const blocks = input.blocks ?? message.blocks;
    if (text === message.text && sameBlocks(blocks, message.blocks)) return false;
    assertText(text, message.attachmentCount, blocks);

    const was = this.matchState(message.id);
    const revision = message.revision + 1;
    const mentions = input.text === undefined ? message.mentions : (input.mentions ?? []);
    this.messages.set(message.id, { ...message, text, mentions, blocks, revision });
    const now = this.matchState(message.id);
    this.record({
      type: "message.edited",
      messageId: message.id,
      actorId: input.by.actorId,
      at: input.now,
      text,
      mentions,
      blocks,
      revision,
      // An edit that drops a mention still reaches whoever was mentioned.
      facets: sameMembers(was.mentions, now.mentions) ? orNull(now) : { ...now, was },
    });
    return true;
  }

  /**
   * Deletes a message, leaving a tombstone in its place so its replies keep
   * their thread. Deleting a tombstone does nothing.
   *
   * @param input.moderator Whether the editor may delete what others wrote.
   */
  delete(input: {
    messageId: string;
    by: Editor;
    moderator?: boolean | undefined;
    revision?: number | undefined;
    now: number;
  }): boolean {
    const message = this.message(input.messageId);
    // Authorship first: deleting a tombstone does nothing for whoever could
    // have deleted the message, and is refused like any delete for the rest.
    if (!wrote(message, input.by) && input.moderator !== true) throw notAuthor();
    if (message.deletedAt !== null) return false;
    if (input.revision !== undefined && input.revision !== message.revision) {
      throw revisionConflict();
    }

    const was = this.matchState(message.id);
    const revision = message.revision + 1;
    this.messages.set(message.id, {
      ...message,
      text: "",
      revision,
      deletedAt: input.now,
      blocks: [],
      labels: {},
      mentions: [],
      reactions: [],
    });
    this.record({
      type: "message.deleted",
      messageId: message.id,
      actorId: input.by.actorId,
      at: input.now,
      revision,
      facets: { ...this.matchState(message.id), was },
    });
    return true;
  }

  /** Adds an actor's reaction, or removes it. Each actor reacts with an emoji once. */
  react(input: {
    messageId: string;
    actorId: string;
    emoji: string;
    remove?: boolean | undefined;
    now: number;
  }): boolean {
    const message = this.live(input.messageId);
    const emoji = normalizeEmoji(input.emoji);
    const remove = input.remove === true;
    const mine = (reaction: { emoji: string; actorId: string }) =>
      reaction.emoji === emoji && reaction.actorId === input.actorId;
    if (message.reactions.some(mine) !== remove) return false;

    this.messages.set(message.id, {
      ...message,
      reactions: remove
        ? message.reactions.filter((reaction) => !mine(reaction))
        : [...message.reactions, { emoji, actorId: input.actorId }],
    });
    this.record({
      type: remove ? "reaction.removed" : "reaction.added",
      messageId: message.id,
      actorId: input.actorId,
      at: input.now,
      emoji,
      facets: orNull(this.matchState(message.id)),
    });
    return true;
  }

  /**
   * Records a change another context decided, and sets the vibe's own labels on
   * the root to match: a value to set one, `null` to remove it. These are the
   * labels under `vibe.`, which nobody can set by hand.
   *
   * A root that was deleted keeps no labels, so there the change is recorded
   * and the labels are left alone.
   *
   * @param input.about The message the change concerns, when that isn't the
   *   root: a reply that was delivered somewhere. It must be loaded.
   */
  note(input: {
    as: string;
    actorId: string;
    about?: string | undefined;
    payload?: Readonly<Record<string, unknown>> | undefined;
    labels?: Readonly<Record<string, string | null>> | undefined;
    now: number;
  }): void {
    const root = this.message(this.state.id);
    const subject = input.about === undefined ? root : this.message(input.about);
    if (subject.id !== root.id && Object.keys(input.labels ?? {}).length > 0) {
      // The labels a note sets are the root's, and are stored under the
      // message the note is about.
      throw new TypeError("A note about a reply sets no labels.");
    }
    const was = this.matchState(subject.id);
    const labels: Record<string, string> = { ...root.labels };
    const set: Record<string, string> = {};
    const unset: string[] = [];
    if (root.deletedAt === null) {
      for (const [key, value] of Object.entries(input.labels ?? {})) {
        if (!key.startsWith(RESERVED_LABEL_PREFIX)) {
          throw new TypeError(`Only the vibe's own labels are noted, and ${key} isn't one.`);
        }
        if (value === null) {
          if (!(key in labels)) continue;
          delete labels[key];
          unset.push(key);
        } else if (labelValue(labels, key) !== value) {
          labels[key] = value;
          set[key] = value;
        }
      }
      this.messages.set(root.id, { ...root, labels });
    }

    const now = this.matchState(subject.id);
    const relabeled = Object.keys(set).length > 0 || unset.length > 0;
    this.record({
      type: "thread.noted",
      as: input.as,
      messageId: subject.id,
      actorId: input.actorId,
      at: input.now,
      payload: input.payload ?? {},
      set,
      unset,
      facets: relabeled ? { ...now, was } : orNull(now),
    });
  }

  private post(input: NewMessage, replyTo: string | null): Message {
    const attachmentIds = input.attachmentIds ?? [];
    const labels = input.labels ?? {};
    const mentions = input.mentions ?? [];
    const blocks = input.blocks ?? [];
    assertContent(input.text, attachmentIds, blocks);
    assertSettable(labels);

    this.messages.set(input.id, {
      id: input.id,
      actorId: input.actorId,
      text: input.text,
      revision: 1,
      deletedAt: null,
      source: input.source ?? null,
      attachmentCount: attachmentIds.length,
      blocks,
      labels,
      mentions,
      reactions: [],
    });
    const message: Message = {
      id: input.id,
      threadId: this.state.id,
      replyTo,
      actorId: input.actorId,
      text: input.text,
      attachmentIds,
      blocks,
      labels,
      mentions,
      position: this.state.version + 1,
      source: input.source ?? null,
      noSync: input.noSync === true,
      createdAt: input.now,
    };
    this.record({
      type: "message.posted",
      messageId: message.id,
      actorId: message.actorId,
      at: input.now,
      message,
      facets: orNull(this.matchState(message.id)),
    });
    return message;
  }

  /** Gives a change the thread's next version, which is what orders it and guards it. */
  private record(change: Unversioned<ThreadEvent>): void {
    const version = this.state.version + 1;
    this.state = { ...this.state, version };
    this.pending.push({ ...change, threadId: this.state.id, threadVersion: version });
  }

  private message(id: string): MessageState {
    const message = this.messages.get(id);
    if (!message) throw messageNotFound(id);
    return message;
  }

  /** A message that can still change: one that hasn't been deleted. */
  private live(id: string): MessageState {
    const message = this.message(id);
    if (message.deletedAt !== null) throw messageDeleted(id);
    return message;
  }

  /** What filters match a message on: its mentions, its own labels, and its thread root's. */
  private matchState(messageId: string): MatchState {
    // Gathered by key in a map: a label may be named for anything, and an
    // object would already hold something under `constructor`.
    const gathered = new Map<string, string[]>();
    for (const id of new Set([messageId, this.state.id])) {
      for (const [key, value] of Object.entries(this.messages.get(id)?.labels ?? {})) {
        const values = gathered.get(key) ?? [];
        if (!values.includes(value)) values.push(value);
        gathered.set(key, values);
      }
    }
    return {
      labels: Object.fromEntries(gathered),
      mentions: this.messages.get(messageId)?.mentions ?? [],
    };
  }

  get id(): string {
    return this.state.id;
  }

  get snapshot(): ThreadState {
    return this.state;
  }

  /** Whether the thread's first message was deleted, and is a tombstone. */
  get rootDeleted(): boolean {
    return this.message(this.state.id).deletedAt !== null;
  }

  /** Hands over what changed since the thread was loaded, for the repository to store. */
  pullEvents(): ThreadEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }
}

function orNull(state: MatchState): EventFacets | null {
  return Object.keys(state.labels).length === 0 && state.mentions.length === 0 ? null : state;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((member) => b.includes(member));
}
