import { principalOf } from "@vibe/kernel";

import { invalidSchedule } from "./errors.ts";

export const SCHEDULE_STATES = ["pending", "done", "canceled", "stopped"] as const;
/**
 * `pending` has a firing ahead of it. `done` has made its last. `canceled` was
 * called off. `stopped` had a firing refused, such as when its author lost
 * the access the post takes.
 */
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** The scheduler looks once a minute, so nothing repeats faster. */
export const MIN_INTERVAL_MS = MINUTE;
export const MIN_DELAY_MS = SECOND;
/** How far ahead a first firing can be, and the longest interval. */
export const MAX_AHEAD_MS = 366 * DAY;
/** How long a schedule can run for, and so how far off any of its times can be. */
export const MAX_SPAN_MS = 10 * 366 * DAY;
export const MAX_TIMES = 10_000;
/** A time this far in the past still counts as now: clocks differ, and requests take a moment. */
const GRACE_MS = MINUTE;

/** When to post, as whoever schedules says it. Times are epoch milliseconds, spans milliseconds. */
export interface Timing {
  /** Once, this long from now. With `every`, the first time. */
  readonly in?: number | undefined;
  /** Once, at this time. With `every`, the first time. */
  readonly at?: number | undefined;
  /** Repeat at this interval. */
  readonly every?: number | undefined;
  /** Repeat for this long, counted from the first firing. */
  readonly for?: number | undefined;
  /** Fire this many times in all. */
  readonly times?: number | undefined;
  /** No firing after this time. */
  readonly until?: number | undefined;
}

/** What a timing comes to. */
export interface Plan {
  readonly firstAt: number;
  readonly every: number | null;
  readonly until: number | null;
  readonly times: number | null;
}

/**
 * Works out when a schedule fires from how it was asked for.
 *
 * @throws `invalid_schedule` when the timing says nothing, contradicts itself,
 *   or asks for more than the scheduler does.
 */
export function plan(timing: Timing, now: number): Plan {
  const { every } = timing;
  if (timing.in === undefined && timing.at === undefined && every === undefined) {
    throw invalidSchedule(
      "A schedule needs a time.",
      "Pass `in` or `at` to post once, or `every` to repeat.",
    );
  }
  if (timing.in !== undefined && timing.at !== undefined) {
    throw invalidSchedule("`in` and `at` both say when to start. Pass one.");
  }
  for (const [name, span] of [
    ["in", timing.in],
    ["every", every],
    ["for", timing.for],
  ] as const) {
    if (span !== undefined && !(Number.isFinite(span) && span > 0)) {
      throw invalidSchedule(`\`${name}\` takes a length of time, such as 30m.`);
    }
  }
  for (const [name, time] of [
    ["at", timing.at],
    ["until", timing.until],
  ] as const) {
    if (time !== undefined && !Number.isFinite(time)) {
      throw invalidSchedule(
        `\`${name}\` takes a time.`,
        "Write it as ISO 8601 with its zone, such as 2026-11-02T09:00:00Z or 2026-11-02T10:00:00+01:00.",
      );
    }
  }
  if (every === undefined) {
    const repeating = (["for", "times", "until"] as const).find((k) => timing[k] !== undefined);
    if (repeating !== undefined) {
      throw invalidSchedule(
        `\`${repeating}\` limits a schedule that repeats.`,
        "Add `every` with the interval to repeat at.",
      );
    }
  } else if (every < MIN_INTERVAL_MS) {
    throw invalidSchedule("The shortest interval is one minute.");
  } else if (every > MAX_AHEAD_MS) {
    throw invalidSchedule("The longest interval is a year.");
  }
  if (timing.for !== undefined && timing.until !== undefined) {
    throw invalidSchedule("`for` and `until` both say when to end. Pass one.");
  }
  if (timing.in !== undefined && timing.in < MIN_DELAY_MS) {
    throw invalidSchedule("The shortest delay is one second.");
  }
  const { times } = timing;
  if (times !== undefined && !(Number.isInteger(times) && times >= 1 && times <= MAX_TIMES)) {
    throw invalidSchedule(
      `\`times\` takes a whole number from 1 to ${MAX_TIMES.toLocaleString("en-US")}.`,
    );
  }

  if (timing.at !== undefined && timing.at < now - GRACE_MS) {
    throw invalidSchedule("`at` is in the past.");
  }
  const firstAt = Math.max(timing.at ?? now + (timing.in ?? every ?? 0), now);
  if (firstAt > now + MAX_AHEAD_MS) {
    throw invalidSchedule("A schedule starts within a year.");
  }
  // Checked before it is added to a time: a span of any size is still a number.
  if (timing.for !== undefined && timing.for > MAX_SPAN_MS) {
    throw invalidSchedule("A schedule runs for ten years at most.");
  }
  const until = timing.until ?? (timing.for === undefined ? null : firstAt + timing.for);
  if (until !== null && until < firstAt) {
    throw invalidSchedule("This schedule would end before its first post.");
  }
  if (until !== null && until > now + MAX_SPAN_MS + MAX_AHEAD_MS) {
    throw invalidSchedule("A schedule ends within ten years.");
  }
  return { firstAt, every: every ?? null, until, times: times ?? null };
}

/** Where a schedule posts. */
export interface Target {
  readonly channel: string;
  /** The root of the thread it replies in, or `null` when each firing starts a thread. */
  readonly threadId: string | null;
  /** The exact message it answers, when that isn't the root. */
  readonly replyTo: string | null;
}

/** What each firing posts. Mentions are settled, and data is checked, when it posts. */
export interface Content {
  readonly text: string;
  readonly labels: Readonly<Record<string, string>>;
  /** Data as it was given: a schema's ID, such as `sandbox@1`, and an object. */
  readonly blocks: readonly { schema: string; data: Readonly<Record<string, unknown>> }[];
  /** Whether each post is kept off every synced platform. */
  readonly noSync: boolean;
}

/** Who scheduled it. Each post is by them, with the access they have when it fires. */
export interface Author {
  readonly actorId: string;
  readonly principal: string;
  readonly profile: string | null;
}

export interface ScheduleSnapshot extends Target, Content, Author {
  readonly id: string;
  readonly vibeId: string;
  readonly state: ScheduleState;
  /** When it fires next, while it is pending. Afterwards, when it last was to. */
  readonly nextAt: number;
  readonly every: number | null;
  readonly until: number | null;
  /** How many firings are left, when it was given a number of them. */
  readonly remaining: number | null;
  /** How many times it has fired. */
  readonly runs: number;
  readonly lastRunAt: number | null;
  readonly lastMessageId: string | null;
  /** Why it stopped, as an error code. */
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * A post to make later, once or at an interval. It fires as its author, who
 * must still be allowed to post there when it does.
 */
export class Schedule {
  private constructor(private state: ScheduleSnapshot) {}

  static create(input: {
    id: string;
    vibeId: string;
    target: Target;
    content: Content;
    author: Author;
    timing: Timing;
    now: number;
  }): Schedule {
    const planned = plan(input.timing, input.now);
    return new Schedule({
      id: input.id,
      vibeId: input.vibeId,
      ...input.target,
      ...input.content,
      actorId: input.author.actorId,
      principal: input.author.principal,
      profile: input.author.profile,
      state: "pending",
      nextAt: planned.firstAt,
      every: planned.every,
      until: planned.until,
      remaining: planned.times,
      runs: 0,
      lastRunAt: null,
      lastMessageId: null,
      reason: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static rehydrate(state: ScheduleSnapshot): Schedule {
    return new Schedule(state);
  }

  get snapshot(): ScheduleSnapshot {
    return this.state;
  }

  get id(): string {
    return this.state.id;
  }

  isDue(now: number): boolean {
    return this.state.state === "pending" && this.state.nextAt <= now;
  }

  /**
   * The key the next firing posts under. A firing that posted but wasn't
   * recorded posts under the same key again, and so posts once.
   */
  get firingKey(): string {
    return `${this.state.id}:${this.state.runs + 1}`;
  }

  /**
   * Records a firing and works out the next. Firings the scheduler missed
   * while it was down are skipped, not made up for: it posts once and carries
   * on from the first of its times that isn't long past.
   *
   * A time counts as missed only once it is more than a scheduler's interval
   * behind. A firing always runs a little after its time, by up to a minute
   * and however long the pass took to reach it, so for a schedule that
   * repeats each minute the next time has often just gone by. That one is
   * late, not missed: it is kept, and goes out on the next pass.
   */
  fired(input: { messageId: string; now: number }): void {
    const { every, until, nextAt } = this.state;
    const remaining = this.state.remaining === null ? null : this.state.remaining - 1;
    let state: ScheduleState = "pending";
    let next = nextAt;
    if (every === null || remaining === 0) {
      state = "done";
    } else {
      const longPast = input.now - MIN_INTERVAL_MS;
      next = nextAt + Math.max(1, Math.ceil((longPast - nextAt) / every)) * every;
      if (until !== null && next > until) {
        state = "done";
        next = nextAt;
      }
    }
    this.state = {
      ...this.state,
      state,
      nextAt: next,
      remaining,
      runs: this.state.runs + 1,
      lastRunAt: input.now,
      lastMessageId: input.messageId,
      updatedAt: input.now,
    };
  }

  /** Ends the schedule because a firing was refused, and keeps the reason. */
  stop(input: { reason: string; now: number }): void {
    if (this.state.state !== "pending") return;
    this.state = { ...this.state, state: "stopped", reason: input.reason, updatedAt: input.now };
  }

  /**
   * Whether this actor scheduled it. A profile cancels only what it scheduled.
   * A principal acting as itself cancels what any of its profiles did.
   */
  scheduledBy(who: Author): boolean {
    if (this.state.actorId === who.actorId) return true;
    return who.profile === null && principalOf(this.state.actorId) === who.principal;
  }

  /**
   * Calls the schedule off.
   *
   * @returns `false` when it had already ended, which changes nothing.
   */
  cancel(input: { now: number }): boolean {
    if (this.state.state !== "pending") return false;
    this.state = { ...this.state, state: "canceled", updatedAt: input.now };
    return true;
  }
}
