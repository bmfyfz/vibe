import type { Clock } from "@vibe/kernel";

import type { Attempts } from "./attempts.ts";
import type { IdentityRepository } from "./ports.ts";

/** What a pass cleared away. */
export interface Cleared {
  /** Sessions that were over, or were opened with a token since revoked. */
  sessions: number;
  /** Delegated tokens that ended more than a day ago. */
  tokens: number;
}

/**
 * How long a delegated token's row is kept after the token ends, so that
 * whoever still holds it is told it expired, and not that nobody knows it.
 */
export const EXPIRED_TOKEN_KEPT_MS = 24 * 60 * 60 * 1000;

/**
 * Clears away what has stopped meaning anything: sessions that are over,
 * delegated tokens long expired, and counts of attempts in stretches that
 * have passed. Nothing here decides anything. A session past its end is
 * refused because every request compares it with the clock, whether or not
 * its row is still there.
 */
export class Upkeep {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly attempts: Attempts,
    private readonly clock: Clock,
  ) {}

  /** One pass. The scheduler runs it each minute. */
  async run(): Promise<Cleared> {
    const now = this.clock.now();
    const [sessions, tokens] = await Promise.all([
      this.repository.pruneSessions(now),
      this.repository.pruneDelegatedTokens(now - EXPIRED_TOKEN_KEPT_MS),
      this.attempts.prune(),
    ]);
    return { sessions, tokens };
  }
}
