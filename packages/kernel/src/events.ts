import type { UnitOfWork } from "./unit-of-work.ts";

/** The parts of a message that filters match on and that a change can alter. */
export interface MatchState {
  /** Each key's values: the message's own, and its thread root's when that differs. */
  readonly labels: Readonly<Record<string, readonly string[]>>;
  /** The IDs of the actors the message mentions. */
  readonly mentions: readonly string[];
}

/**
 * What filters see of an event: its message as the change left it, and in `was`
 * as it stood before, when the change altered either. An event matches a filter
 * if the message matched before or after, so whoever follows a view also sees
 * a message leave it.
 */
export interface EventFacets extends MatchState {
  readonly was?: MatchState;
}

/**
 * Events that only keep the books, such as each renewal of a task's lease and
 * each receipt of a message's copy on a synced platform.
 * Followers are spared them unless they ask for everything.
 */
export const BOOKKEEPING_EVENTS: readonly string[] = ["task.renewed", "message.synced"];

/** One change to a vibe, as a context hands it to the event log. */
export interface EventRecord {
  readonly vibeId: string;
  /** What happened, such as `message.posted`. */
  readonly type: string;
  readonly channel: string | null;
  readonly threadId: string | null;
  /**
   * The thread's version after this change. The log refuses two events with the
   * same thread and version, which is what makes a stale write fail.
   */
  readonly threadVersion: number | null;
  readonly messageId: string | null;
  readonly actorId: string;
  readonly payload: Record<string, unknown>;
  /** `null` when the message has nothing a filter could match on, before or after. */
  readonly facets: EventFacets | null;
  readonly createdAt: number;
}

/** The write side of the event log. Every context appends in the same unit of work as its own state. */
export interface EventLog {
  append(uow: UnitOfWork, events: readonly EventRecord[]): void;
  /** Whether a failed commit lost a race on a thread's version, and is worth retrying from fresh state. */
  isVersionConflict(error: unknown): boolean;
}
