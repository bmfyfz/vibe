import { DomainError } from "@vibe/kernel";

/** How a message's copy on a platform stands. */
export type CopyState =
  /** On its way out: not tried yet, or waiting to be tried again. */
  | "pending"
  /** The platform has it. */
  | "done"
  /** Given up on, after the retries. */
  | "failed"
  /** Never sent, because there was nothing left to send or nowhere to send it. */
  | "skipped";

/** A delivery that failed is tried again this many times before it is given up on. */
export const MAX_RETRIES = 5;

// How long to leave a platform alone after each failed attempt.
const WAITS_MS = [2_000, 10_000, 30_000, 120_000, 600_000];

/**
 * How long to wait before the next attempt, once `failed` attempts have
 * failed, or `null` when there is none left: the first attempt and its
 * retries have all failed, and the delivery is recorded as failed.
 *
 * @param retryAfterMs What the platform asked for, when it said. The wait is at least that.
 */
export function retryWait(failed: number, retryAfterMs: number | null = null): number | null {
  if (failed > MAX_RETRIES) return null;
  const wait = WAITS_MS[Math.max(failed, 1) - 1] ?? WAITS_MS[WAITS_MS.length - 1] ?? 600_000;
  return Math.max(wait, retryAfterMs ?? 0);
}

/** A platform's API refused a call, or could not be reached. */
export class PlatformError extends Error {
  constructor(
    message: string,
    /** How long the platform asked to be left alone, when it said. */
    readonly retryAfterMs: number | null = null,
    /**
     * Whether asking again would be answered the same: the channel is gone,
     * the app isn't in it, the text is one the platform won't take. A
     * delivery refused so is recorded as failed at once.
     */
    readonly permanent = false,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

/** How much of what went wrong is kept and shown. */
export const MAX_ERROR_LENGTH = 300;

export function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Whether the vibe's refusal of something a platform sent is its last word,
 * so that the event is done with and being sent again would change nothing.
 * A thread too busy to write to is not: the same event, a moment later,
 * lands. Neither is a failure that isn't a refusal at all.
 */
export function isFinalRefusal(error: unknown): error is DomainError {
  return error instanceof DomainError && error.code !== "write_conflict";
}
