import type { EventFilter } from "@vibe/activity";
import type {
  SyncedView,
  SyncInboxEntry,
  SyncSource as SourceView,
  VibeEvent,
} from "@vibe/contracts";
import type { Caller } from "@vibe/identity";
import type { ChannelScope, UnitOfWork } from "@vibe/kernel";
import type { VibeRecord } from "@vibe/messaging";

import type { CopyState } from "../domain/delivery.ts";
import type { Source } from "../domain/source.ts";

/** A sync entry as it is stored: with its credentials, sealed. */
export interface StoredSource extends Source {
  readonly sealed: string;
}

export interface SourceRepository {
  find(vibeId: string, key: string): Promise<StoredSource | null>;
  byId(id: string): Promise<StoredSource | null>;
  count(vibeId: string): Promise<number>;
  /** A vibe's entries that sync, oldest first. */
  active(vibeId: string): Promise<StoredSource[]>;
  /**
   * The active entries, in any vibe, that have something to do and that no
   * pass holds: their vibe's log is ahead of them, or a copy of theirs is due.
   */
  due(now: number, limit: number): Promise<StoredSource[]>;
  /** Adds an entry that reads the log from `seq`: it syncs what is written after. */
  add(uow: UnitOfWork, source: StoredSource, seq: number, now: number): void;
  /**
   * Stores an entry's credentials, and what the platform says of them. A
   * unit of work that finds the entry gone writes nothing.
   */
  recredential(uow: UnitOfWork, source: StoredSource): void;
  /** Removes an entry and every record it kept. What came in through it stays on the vibe. */
  remove(uow: UnitOfWork, source: Source): void;
  /** Ends an entry, with the reason as an error code. */
  stop(sourceId: string, reason: string): Promise<void>;
}

export interface CursorRepository {
  /**
   * Takes an entry's deliveries for one pass, until `until`. Two passes never
   * hold the same entry.
   *
   * @returns Where the entry stands in the log, or `null` when another pass holds it.
   */
  lease(sourceId: string, now: number, until: number): Promise<{ seq: number } | null>;
  /** Keeps a pass's hold until `until`. `false` when the pass no longer has it, and must stop. */
  renew(sourceId: string, held: number, until: number): Promise<boolean>;
  /**
   * Moves the cursor in a unit of work, from where the pass found it. The
   * statement changes nothing when the cursor is elsewhere.
   */
  advance(uow: UnitOfWork, sourceId: string, from: number, to: number, now: number): void;
  /** Lets go of the entry. */
  release(sourceId: string, held: number, now: number): Promise<void>;
}

/** A vibe thread joined with a platform thread, through one entry. */
export interface SyncedThread {
  readonly id: string;
  readonly sourceId: string;
  readonly vibeId: string;
  /** The vibe thread, by its root. */
  readonly threadId: string;
  readonly platformChannel: string;
  /** `null` until the vibe thread's root has been delivered. */
  readonly platformThread: string | null;
  readonly url: string | null;
  /** Where the vibe's log stood when the two were joined. */
  readonly sinceSeq: number;
  readonly state: "active" | "failed";
  readonly createdBy: string;
  readonly createdAt: number;
}

/** Which vibe message is which platform message, and how its delivery is going. */
export interface Copy {
  readonly syncThreadId: string;
  readonly messageId: string;
  readonly sourceId: string;
  readonly direction: "in" | "out";
  readonly platformMessage: string | null;
  readonly url: string | null;
  readonly state: CopyState;
  /** The place of the event that posted the message. */
  readonly seq: number;
  readonly attempts: number;
  readonly retryAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type PlacedCopy = Copy & { readonly thread: SyncedThread };

export interface SyncRecords {
  /** An entry's joins of a vibe thread that still sync. */
  threadsOf(sourceId: string, threadId: string): Promise<SyncedThread[]>;
  /** Every join of a vibe thread, through any entry. */
  joins(vibeId: string, threadId: string): Promise<SyncedThread[]>;
  threadByPlatform(sourceId: string, platformThread: string): Promise<SyncedThread | null>;
  copyByPlatform(sourceId: string, platformMessage: string): Promise<PlacedCopy | null>;
  /** An entry's copies of one vibe message, and the platform messages it came in as. */
  copiesOf(sourceId: string, messageId: string): Promise<PlacedCopy[]>;
  /** The copies that are due to go out, in the order their messages were posted. */
  due(sourceId: string, now: number, limit: number): Promise<PlacedCopy[]>;
  /** A copy and its thread as they stand now: a list of what is due ages while it is worked through. */
  current(copy: Copy): Promise<PlacedCopy | null>;
  /** Whether a thread's first message is still on its way out, so that its replies should wait. */
  starting(syncThreadId: string, rootId: string): Promise<boolean>;
  /**
   * Joins a vibe thread with a platform thread. A commit that finds the
   * platform thread taken fails as a whole.
   */
  addThread(uow: UnitOfWork, thread: SyncedThread): void;
  /**
   * Records a message that came from the platform. A commit that finds the
   * platform message already recorded fails as a whole: it came in before.
   */
  addCopy(uow: UnitOfWork, copy: Copy): void;
  /** Plans a copy to go out, unless the message already has one in that thread. */
  planCopy(uow: UnitOfWork, copy: Copy): void;
  /**
   * Puts on record the ID a copy is about to be given, and with `start` that
   * its thread is about to be: for a platform that takes the ID from us.
   */
  intend(copy: PlacedCopy, platformMessage: string, start: boolean): Promise<void>;
  /** Records that a thread was started on the platform with a copy. */
  started(
    copy: PlacedCopy,
    sent: { thread: string; message: string; url: string | null },
    now: number,
  ): Promise<void>;
  delivered(
    copy: PlacedCopy,
    sent: { message: string; url: string | null },
    now: number,
  ): Promise<void>;
  /** Records a failed attempt, and when the next may be made. */
  retry(
    copy: PlacedCopy,
    attempts: number,
    retryAt: number,
    error: string,
    now: number,
  ): Promise<void>;
  /** Gives up on a copy. With `thread`, on its thread too: it could not be started. */
  failed(
    copy: PlacedCopy,
    attempts: number,
    error: string,
    now: number,
    thread: boolean,
  ): Promise<void>;
  /** Ends a copy that has nothing to send, or nowhere to send it. */
  skip(copy: PlacedCopy, now: number): Promise<void>;
  /** Whether a failed commit found a platform thread already joined with another vibe thread. */
  isTaken(error: unknown): boolean;
  /** Whether a failed commit found a platform message already recorded. */
  isDuplicate(error: unknown): boolean;
}

export interface ReceivedEvent {
  sourceId: string;
  deliveryId: string;
  event: string;
  body: string;
  receivedAt: number;
}

/** The raw events an entry received, and what became of each. */
export interface Inbox {
  /**
   * Records an event.
   *
   * @returns `false` when the same delivery was recorded and dealt with
   *   before: a platform sent it again, and there is nothing left to do.
   */
  receive(event: ReceivedEvent): Promise<boolean>;
  /** Says what came of an event. One that was ignored keeps no body: it was not brought in, and is not kept. */
  settle(
    sourceId: string,
    deliveryId: string,
    state: "done" | "ignored" | "failed",
    note: string | null,
  ): Promise<void>;
  /** The newest first. */
  list(sourceId: string, limit: number): Promise<SyncInboxEntry[]>;
  /**
   * The vibe channels of every thread an entry syncs with, or did: where what
   * it received may have been written, beyond the channels it maps.
   */
  writesInto(sourceId: string): Promise<string[]>;
}

/**
 * Keeps platform credentials unreadable at rest: what the database holds
 * can't be used by whoever reads only the database.
 */
export interface Vault {
  /** @param context What the secret belongs to. It opens only with the same. */
  seal(plain: string, context: string): Promise<string>;
  /** @throws When it was sealed under another key or for something else. */
  open(sealed: string, context: string): Promise<string>;
}

export interface KnownActor {
  id: string;
  handle: string;
  name: string;
}

/** Where platform users become actors of the vibe. */
export interface PlatformActors {
  find(actorId: string): Promise<KnownActor | null>;
  /**
   * Makes sure a platform user's actor exists, under the first of the
   * handles that is free.
   *
   * @returns The actor as it is on record: one that existed keeps the handle and the name it had.
   */
  ensure(
    actor: {
      id: string;
      teamId: string;
      principal: string;
      profile: string;
      name: string;
      handles: readonly string[];
    },
    now: number,
  ): Promise<KnownActor>;
}

/** A thread as joining it with a platform needs it. */
export interface ThreadOutline {
  /** The root's ID. */
  id: string;
  channel: string;
  /** Whether the root keeps the whole thread off every platform. */
  noSync: boolean;
  /** Its messages in order, each with the place of the event that posted it. */
  messages: { id: string; seq: number; noSync: boolean; deleted: boolean }[];
}

export interface ThreadReader {
  outline(vibeId: string, messageId: string): Promise<ThreadOutline | null>;
}

/** Finds a principal as it is now, with the role it has now. */
export interface CallerDirectory {
  callerOf(principal: string, profile: string | null): Promise<Caller | null>;
}

export interface VibeDirectory {
  find(id: string): Promise<VibeRecord | null>;
}

/** The team's services, as naming one for a sync entry needs them. */
export interface ServiceDirectory {
  /** A service by its name, as its principal ID. `null` when the team has none by that name. */
  principalOf(caller: Caller, name: string): Promise<string | null>;
}

/** The event log, as a consumer that keeps its own place in it reads it. */
export interface EventSource {
  /** How far a vibe's log has got. */
  place(vibeId: string): Promise<number>;
  since(
    vibeId: string,
    place: number,
    filter: EventFilter,
    limit: number,
    scope: () => Promise<ChannelScope>,
  ): Promise<{
    events: { place: number; channel: string | null; event: VibeEvent }[];
    upto: number;
  }>;
}

/**
 * Whatever runs a pass later: a queue on a Worker, a timer under Bun. It is
 * only ever a prompt. One that is lost costs a delay, until the scheduler's
 * own pass, and one that is repeated finds nothing left to do.
 */
export interface DeliveryTrigger {
  request(vibeId: string, delayMs: number): void;
}

/** The read side: sync as the API shows it. */
export interface SyncQueries {
  /** A vibe's entries, by key, each with how its deliveries stand. */
  sources(vibeId: string): Promise<SourceView[]>;
  source(vibeId: string, id: string): Promise<SourceView | null>;
  /**
   * Where a thread is synced, with the platform's link to the copy of one of
   * its messages, and the deliveries that failed.
   */
  synced(vibeId: string, threadId: string, messageId: string): Promise<SyncedView>;
}
