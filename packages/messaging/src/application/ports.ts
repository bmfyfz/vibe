import type { Actor, Channel, Message, ThreadSummary } from "@vibe/contracts";
import type { ChannelPattern, ChannelScope, LabelFilter, UnitOfWork } from "@vibe/kernel";

import type { Schema, SchemaRef } from "../domain/schema.ts";
import type { Thread, ThreadEvent } from "../domain/thread.ts";

export interface VibeRecord {
  id: string;
  teamId: string;
  name: string;
  createdAt: number;
}

export interface VibeRepository {
  findByName(teamId: string, name: string): Promise<VibeRecord | null>;
  findById(id: string): Promise<VibeRecord | null>;
  /** Stores the vibe unless the team already has one by that name. */
  addIfMissing(vibe: VibeRecord): Promise<void>;
  list(teamId: string): Promise<VibeRecord[]>;
}

export interface ChannelRecord {
  vibeId: string;
  path: string;
  createdBy: string;
  createdAt: number;
}

export interface ChannelRepository {
  find(vibeId: string, path: string): Promise<Channel | null>;
  /** Whether the channel, or any channel under it, exists. */
  existsAtOrUnder(vibeId: string, path: string): Promise<boolean>;
  /** Adds a channel that must not exist yet: a commit that finds it there fails as a whole. */
  add(uow: UnitOfWork, channel: ChannelRecord): void;
  /** Whether a failed commit found the channel already there. */
  isTaken(error: unknown): boolean;
}

export interface ThreadRepository {
  /**
   * Loads the thread that holds a message, from any message in it, with what a
   * change to that message is decided from.
   */
  findByMessage(vibeId: string, messageId: string): Promise<Thread | null>;
  /** Adds the thread's new state, and what its events did to its messages, to a unit of work. */
  save(uow: UnitOfWork, thread: Thread, events: readonly ThreadEvent[]): void;
  /** Whether a failed commit tried to attach a file that another message got first. */
  isAttachmentTaken(error: unknown): boolean;
}

export interface AttachmentRecord {
  id: string;
  vibeId: string;
  /** The principal that uploaded it. */
  uploader: string;
  /** The actor that uploaded it, when that was kept. */
  uploadedBy: string | null;
  blobKey: string;
  name: string;
  type: string;
  size: number;
  createdAt: number;
}

export interface PlacedAttachment extends AttachmentRecord {
  /** The message it joined, and that message's channel. Both `null` until it's posted. */
  messageId: string | null;
  channel: string | null;
  /** Whether its message was deleted, which hides the file from the message's readers. */
  hidden: boolean;
}

export interface AttachmentRepository {
  add(attachment: AttachmentRecord): Promise<void>;
  find(vibeId: string, id: string): Promise<PlacedAttachment | null>;
  findMany(vibeId: string, ids: readonly string[]): Promise<PlacedAttachment[]>;
}

export interface IdempotencyEntry {
  principal: string;
  key: string;
  /** What the key was used for: a channel to start a thread in, or a thread to reply in. */
  target: string;
  messageId: string;
  createdAt: number;
}

export interface IdempotencyStore {
  find(principal: string, key: string): Promise<IdempotencyEntry | null>;
  record(uow: UnitOfWork, entry: IdempotencyEntry): void;
  /** Whether a failed commit lost to another request that used the same key. */
  isDuplicate(error: unknown): boolean;
}

export interface SchemaRepository {
  find(teamId: string, ref: SchemaRef): Promise<Schema | null>;
  /** The team's schemas, by name and then version. */
  list(teamId: string): Promise<Schema[]>;
  /** Adds a version that must not exist yet: a commit that finds it there fails as a whole. */
  add(uow: UnitOfWork, schema: Schema): void;
  /** Whether a failed commit found the version already registered. */
  isTaken(error: unknown): boolean;
}

/** Checks data against a JSON Schema. A port, so nothing here depends on which validator runs. */
export interface SchemaChecker {
  /** Why a definition can't be used as a schema, or `null` when it can. */
  unusable(definition: Readonly<Record<string, unknown>>): string | null;
  /** How the data fails the definition, or `null` when it matches. */
  mismatch(definition: Readonly<Record<string, unknown>>, data: unknown): string | null;
}

export interface ThreadFilter {
  channel: ChannelPattern;
  /**
   * A handle or an actor ID. Matches threads with a message by that author. A
   * person's handle covers what their profiles wrote too.
   */
  by?: string | undefined;
  /** Threads with a message that carries every one of these labels. A root's labels count for its whole thread. */
  labels?: readonly LabelFilter[] | undefined;
  /** An actor ID. Matches threads with a message that mentions that actor. */
  mentions?: string | undefined;
  /** Threads with a message from here: a sync entry's key, or `vibe` for what was written on the vibe. */
  source?: string | undefined;
  /** Only threads with activity after this place in the event log. */
  afterSeq?: number | undefined;
  limit: number;
}

/** The read side. Queries skip the aggregates and return the API's own shapes. */
export interface MessagingQueries {
  listChannels(vibeId: string): Promise<Channel[]>;
  /** A vibe's latest threads that match, among the channels in `scope`. */
  listThreads(vibeId: string, filter: ThreadFilter, scope: ChannelScope): Promise<ThreadSummary[]>;
  getThread(
    vibeId: string,
    messageId: string,
  ): Promise<{ message: Message; replies: Message[] } | null>;
  getMessage(vibeId: string, messageId: string): Promise<Message | null>;
  /** The team's people, and the profiles that have written. */
  listActors(teamId: string): Promise<Actor[]>;
  /** Who has written in which channels of a vibe, each pair once. */
  listAuthors(vibeId: string): Promise<{ actorId: string; channel: string }[]>;
}
