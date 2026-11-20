import type { EventFilter } from "@vibe/activity";
import type { Schedule as ScheduleView, VibeEvent, Watcher as WatcherView } from "@vibe/contracts";
import type { Caller } from "@vibe/identity";
import type { ChannelPattern, ChannelScope, UnitOfWork } from "@vibe/kernel";
import type { VibeRecord } from "@vibe/messaging";

import type { Schedule, ScheduleSnapshot } from "../domain/schedule.ts";
import type { Watcher } from "../domain/watcher.ts";

export interface ScheduleRepository {
  find(vibeId: string, id: string): Promise<Schedule | null>;
  /** The pending schedules whose time has come, in any vibe, the longest overdue first. */
  due(now: number, limit: number): Promise<Schedule[]>;
  add(uow: UnitOfWork, schedule: Schedule): void;
  /**
   * Stores what a firing, a stop or a cancel made of a schedule, provided it
   * is still as it was read: pending, and fired as many times. A change that
   * lost a race to another writes nothing.
   */
  save(uow: UnitOfWork, schedule: Schedule, was: ScheduleSnapshot): void;
}

export interface ScheduleFilter {
  channel: ChannelPattern;
  /** A handle or an actor ID. A person's handle covers what their profiles scheduled. */
  by?: string | undefined;
  /** Only those that reply in the thread with this root. */
  threadId?: string | undefined;
  /** Include those that are done, canceled or stopped. */
  all?: boolean | undefined;
  limit: number;
}

/** The read side: schedules as the API shows them. */
export interface ScheduleQueries {
  /**
   * Schedules that match, oldest first, among those the reader can see: the
   * ones in a channel in `scope`, and the reader's own.
   */
  list(
    vibeId: string,
    filter: ScheduleFilter,
    scope: ChannelScope,
    reader: Caller,
  ): Promise<ScheduleView[]>;
  get(vibeId: string, id: string): Promise<ScheduleView | null>;
}

/** Finds whoever scheduled a post as they are now, with the role they have now. */
export interface CallerDirectory {
  callerOf(principal: string, profile: string | null): Promise<Caller | null>;
}

export interface VibeDirectory {
  find(id: string): Promise<VibeRecord | null>;
}

/** Where a watcher's deliveries stand. */
export interface DeliveryState {
  /** The last event it was delivered, or spared. */
  seq: number;
  /** Failed attempts at the delivery it is stuck on. */
  attempts: number;
}

export interface WatcherRepository {
  /** A vibe's watcher, by its ID or its name. */
  find(vibeId: string, idOrName: string): Promise<Watcher | null>;
  count(vibeId: string): Promise<number>;
  /** A vibe's watchers that are still delivered to. */
  active(vibeId: string): Promise<Watcher[]>;
  /**
   * The active watchers, in any vibe, that are behind their vibe's log, whose
   * wait after a failed attempt is over and that no pass holds.
   */
  due(now: number, limit: number): Promise<Watcher[]>;
  /** Adds a watcher that starts from `seq`: it gets what is written after it. */
  add(uow: UnitOfWork, watcher: Watcher, seq: number, now: number): void;
  remove(uow: UnitOfWork, watcher: Watcher): void;
  /**
   * Takes a watcher's deliveries for one pass, until `until`. Two passes never
   * hold the same watcher, which is what keeps its deliveries in order.
   *
   * @returns `null` when another pass holds them, when the watcher is waiting
   *   out a failed attempt, or when it is gone.
   */
  lease(watcherId: string, now: number, until: number): Promise<DeliveryState | null>;
  /**
   * Moves the cursor past a delivery that went through, and holds the watcher
   * until `until`.
   *
   * @returns `false` when the cursor is no longer at `from`: the watcher was
   *   deleted, or the pass lost its hold. The pass must stop.
   */
  advance(
    watcherId: string,
    from: number,
    to: number,
    now: number,
    until: number,
  ): Promise<boolean>;
  /** Ends a pass: moves the cursor past what didn't match, and lets go of the watcher. */
  settle(watcherId: string, from: number, to: number, now: number): Promise<void>;
  /** Records a failed attempt and when the next may be made, and lets go of the watcher. */
  failed(
    watcherId: string,
    from: number,
    failure: { attempts: number; retryAt: number; status: number | null; error: string },
    now: number,
  ): Promise<void>;
  /** Ends a watcher for good, with the reason as an error code. */
  stop(watcherId: string, reason: string): Promise<void>;
}

/** The read side: watchers as the API shows them. */
export interface WatcherQueries {
  list(vibeId: string): Promise<WatcherView[]>;
  get(vibeId: string, id: string): Promise<WatcherView | null>;
}

/** The event log, as a consumer that keeps its own place in it reads it. */
export interface EventSource {
  /** How far a vibe's log has got. */
  place(vibeId: string): Promise<number>;
  /**
   * The matching events after a place, oldest first, among the channels in
   * `scope`, each with the channel it concerns, and `upto`: where the
   * consumer stands once it has handled them.
   */
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

/** How Vibe reaches another server. `fetch`, where nothing else is given. */
export type Send = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Whatever runs a delivery pass later: a queue on a Worker, a timer under
 * Bun. It is only ever a prompt. A request that is lost costs a delay, until
 * the scheduler's own pass, and one that is repeated finds nothing left to do.
 */
export interface DeliveryTrigger {
  /** Asks for a pass over a vibe's watchers, `delayMs` from now. Returns at once, and never throws. */
  request(vibeId: string, delayMs: number): void;
}
