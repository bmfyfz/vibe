const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Reads a duration as milliseconds. A number is milliseconds already. A string
 * is a number with a unit, such as `30s`, `10m` or `1h`, or a bare number of seconds.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (Number.isFinite(input) && input >= 0) return input;
  } else {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(input.trim());
    const unit = UNITS[match?.[2] ?? "s"];
    if (match?.[1] !== undefined && unit !== undefined) return Number(match[1]) * unit;
  }
  throw new VibeError(
    "invalid_duration",
    `"${input}" is not a duration.`,
    0,
    "Use a number with a unit, such as 30s, 10m or 1h.",
  );
}

/** A failed call: Vibe's reason `code`, a message, the HTTP `status`, and a `hint` when something fixes it. */
export class VibeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status, or 0 when the handle raised the error itself. */
    readonly status: number,
    readonly hint?: string,
    /**
     * How many seconds to leave before asking again, when Vibe said: it does
     * with `rate_limited`, which passes by itself.
     */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "VibeError";
  }
}

/**
 * The error a response that isn't a success stands for: Vibe's `code`,
 * `message` and `hint` from its body, and `retryAfter` from its headers. For
 * a caller that speaks to the API without a handle.
 */
export async function failure(response: Response): Promise<VibeError> {
  const body = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
    hint?: string;
  } | null;
  const wait = Number(response.headers.get("retry-after") ?? Number.NaN);
  return new VibeError(
    body?.code ?? "http_error",
    body?.message ?? `Vibe answered ${response.status}.`,
    response.status,
    body?.hint,
    Number.isFinite(wait) && wait >= 0 ? wait : undefined,
  );
}

/**
 * Whether a failed ask after a sign-in should simply be made again later:
 * Vibe bounds how often an address asks, and says how long to leave it.
 *
 * @returns How many seconds to wait, or `null` for a failure that is one.
 */
export function askAgainIn(error: unknown): number | null {
  if (!(error instanceof VibeError) || error.code !== "rate_limited") return null;
  // What the server says is advice, held to what Vibe would say: a stretch
  // is a minute. An answer of a day, or of a number no timer can hold, is
  // not followed.
  return Math.min(Math.max(error.retryAfter ?? 5, 1), LONGEST_WAIT_SECONDS);
}

const LONGEST_WAIT_SECONDS = 60;

/** A sign-in that was waited on for longer than its code lasts. */
export const signInRanOut = () =>
  new VibeError(
    "login_expired",
    "This sign-in ran out before it was approved.",
    0,
    "Start again, and enter the new code.",
  );
