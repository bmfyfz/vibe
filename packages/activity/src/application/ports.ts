import type { Actor, Message } from "@vibe/contracts";
import type { ChannelPattern, ChannelScope, LabelFilter } from "@vibe/kernel";

/**
 * The filters `read`, `tail` and `wait` share. An event must match all of them,
 * on its message as the change left it or as it stood before the change.
 */
export interface EventFilter {
  channel: ChannelPattern;
  /** Only events in the thread whose root has this ID. */
  re?: string | undefined;
  /** A handle or an actor ID: only events about messages by that author, or by a profile of that person. */
  by?: string | undefined;
  /** Labels on the event's message or on its thread's root. */
  labels?: readonly LabelFilter[] | undefined;
  /** An actor ID: only events about messages that mention that actor. */
  mentions?: string | undefined;
  /** Only events about messages from here: a sync entry's key, or `vibe`. */
  source?: string | undefined;
  /** Include the events that only keep the books. */
  all?: boolean | undefined;
}

/**
 * Reads the caller's scope as it is now. A request that waits can outlive a
 * change to the grants, so the feed asks again each time it looks.
 */
export type CurrentScope = () => Promise<ChannelScope>;

export interface StoredEvent {
  seq: number;
  /** The channel it concerns, or `null` for an event that concerns none. */
  channel: string | null;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
  message: Message | null;
  actor: Actor;
}

/**
 * Where live clients listen for news. It is told how far a vibe's log has got
 * after each commit, and nothing else: a client that hears there is something
 * new asks the feed for it, and the feed decides what that client may read.
 */
export interface Hub {
  /**
   * Says a commit took the vibe's log to `seq`. It returns at once, and never
   * throws: a poke that goes missing delays a client, and is covered by the
   * client asking again on its own.
   */
  poke(vibeId: string, seq: number): void;
}

/** The read side of the event log. */
export interface EventFeed {
  /** The newest place in a vibe's log, or 0 when it's empty. */
  head(vibeId: string): Promise<number>;
  /** The place of the event that posted a message, and the channel it was posted in. */
  seqOfMessage(vibeId: string, messageId: string): Promise<{ seq: number; channel: string } | null>;
  /**
   * Events after `afterSeq`, up to and including `uptoSeq` when given, oldest
   * first, among the channels in the caller's scope. An event that concerns no
   * channel reaches only a caller who can read them all.
   *
   * @param scope Asked after each page of events is read, never before, so it
   *   reflects every grant that was in force when those events were written.
   */
  read(
    vibeId: string,
    range: { afterSeq: number; uptoSeq?: number },
    filter: EventFilter,
    limit: number,
    scope: CurrentScope,
  ): Promise<StoredEvent[]>;
}
