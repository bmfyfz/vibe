import type { EventsPage, VibeEvent } from "@vibe/contracts";
import { type Clock, notFound, type Sleep } from "@vibe/kernel";

import { decodeCursor, encodeCursor, isMessageId } from "../domain/cursor.ts";
import type { CurrentScope, EventFeed, EventFilter, StoredEvent } from "./ports.ts";

export interface PollQuery {
  vibeId: string;
  /** A cursor or a message ID to continue from. Omit to start from now. */
  after?: string | undefined;
  filter: EventFilter;
  /** Reads the channels the caller can read. Nothing outside them is returned. */
  scope: CurrentScope;
  /** How long to wait for a first event before answering with none. */
  waitMs: number;
  limit: number;
  signal?: AbortSignal | undefined;
}

export class ActivityService {
  constructor(
    private readonly feed: EventFeed,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    /** How often a waiting request looks again. Each look is one indexed query. */
    private readonly pollIntervalMs: number,
  ) {}

  /** The cursor for "now": everything already in the log is behind it. */
  async head(vibeId: string): Promise<string> {
    return encodeCursor(await this.feed.head(vibeId));
  }

  /** How far a vibe's log has got, as a place a consumer of it can keep. 0 for an empty log. */
  place(vibeId: string): Promise<number> {
    return this.feed.head(vibeId);
  }

  /**
   * The next events for a consumer that keeps its own place in the log, such
   * as a watcher. The log is the outbox: whatever prompts the consumer to
   * look may be late, lost or repeated, and its place still says what it has
   * been through.
   *
   * @param place The last place the consumer got to.
   * @returns The matching events after it, oldest first, each with its place
   *   and the channel it concerns, and `upto`: the place the consumer has reached once it has handled them
   *   all. It moves on past what didn't match, and never past an event that
   *   was not looked at.
   */
  async since(
    vibeId: string,
    place: number,
    filter: EventFilter,
    limit: number,
    scope: CurrentScope,
  ): Promise<{
    events: { place: number; channel: string | null; event: VibeEvent }[];
    upto: number;
  }> {
    // The head is fixed before the read. An event that lands in between is
    // past `upto`, and so is in the next page, never skipped.
    const head = await this.feed.head(vibeId);
    if (head <= place) return { events: [], upto: place };
    const range = { afterSeq: place, uptoSeq: head };
    const found = await this.feed.read(vibeId, range, filter, limit, scope);
    const last = found[found.length - 1];
    return {
      events: found.map((event) => ({
        place: event.seq,
        channel: event.channel,
        event: view(event),
      })),
      // A full page may have left more behind it.
      upto: last && found.length === limit ? last.seq : head,
    };
  }

  /** Turns what a client passed as `after` into a place in the log. */
  async resolve(vibeId: string, after: string, scope: CurrentScope): Promise<number> {
    if (!isMessageId(after)) return decodeCursor(after);
    const posted = await this.feed.seqOfMessage(vibeId, after);
    if (posted === null || !(await scope()).allows(posted.channel)) {
      throw notFound("message_not_found", `No message has the ID ${after}, or you can't read it.`);
    }
    return posted.seq;
  }

  /**
   * Returns the events after a cursor, waiting up to `waitMs` for the first one.
   * The cursor it returns is always safe to continue from: nothing before it is
   * left unseen, and it moves forward even when nothing matched the filters.
   */
  async poll(query: PollQuery): Promise<EventsPage> {
    const { vibeId, filter, limit, scope, signal } = query;
    const afterSeq =
      query.after === undefined
        ? await this.feed.head(vibeId)
        : await this.resolve(vibeId, query.after, scope);
    const deadline = this.clock.now() + query.waitMs;

    for (;;) {
      const found = await this.feed.read(vibeId, { afterSeq }, filter, limit, scope);
      if (found.length > 0) return page(found);
      const remaining = deadline - this.clock.now();
      if (remaining <= 0 || signal?.aborted) break;
      await this.sleep(Math.min(this.pollIntervalMs, remaining), signal);
    }

    // Nothing matched. To move the cursor past what was ruled out, fix a head
    // first and then look once more up to it: an event that lands in between
    // is either in this last read or after the cursor, never skipped.
    const head = await this.feed.head(vibeId);
    if (head <= afterSeq) return { events: [], cursor: encodeCursor(afterSeq) };
    const late = await this.feed.read(vibeId, { afterSeq, uptoSeq: head }, filter, limit, scope);
    return late.length > 0 ? page(late) : { events: [], cursor: encodeCursor(head) };
  }
}

function page(found: StoredEvent[]): EventsPage {
  const last = found[found.length - 1];
  return { events: found.map(view), cursor: encodeCursor(last ? last.seq : 0) };
}

function view(event: StoredEvent): VibeEvent {
  return {
    cursor: encodeCursor(event.seq),
    type: event.type,
    createdAt: new Date(event.createdAt).toISOString(),
    payload: event.payload,
    message: event.message,
    actor: event.actor,
  };
}
