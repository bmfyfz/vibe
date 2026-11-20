import type { Clock } from "@vibe/kernel";

import {
  attemptKey,
  type Budget,
  tooManyAttempts,
  type Window,
  windowAt,
} from "../domain/attempts.ts";

/** Where attempts are counted. Every method is one statement, so counts hold when requests race. */
export interface AttemptRepository {
  /** Whether any of the keys has `most` attempts or more in a stretch that has not ended at `now`. */
  spent(keys: readonly string[], most: number, now: number): Promise<boolean>;
  /**
   * Counts one attempt under a key in a stretch, starting the count again
   * when the stretch is new, unless the key already has `most` there.
   *
   * @returns Whether it was counted. `false` means the key had used the stretch up.
   */
  add(key: string, window: Window, most: number): Promise<boolean>;
  /** Takes one attempt back from a key's count in a stretch, when it is still the one being counted. */
  subtract(key: string, window: Window): Promise<void>;
  /** Forgets the counts of stretches that ended before `now`. */
  prune(now: number): Promise<void>;
}

/** An attempt that was counted before it was tried, to hand back when it turns out to have been good. */
export interface Taken {
  readonly key: string;
  readonly window: Window;
}

/**
 * Bounds how often something can be tried from one place: a credential
 * guessed, a sign-in started. Each caller is counted under a key of its own,
 * so one that uses its budget up is refused, and no one else is.
 *
 * `who` is whoever the attempts are counted against, such as a network
 * address. With no one to count against, nothing is counted and nothing is
 * refused: a budget everyone shared would let one caller lock out the rest.
 */
export class Attempts {
  constructor(
    private readonly repository: AttemptRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * Refuses a caller that has used the budget up under any of the names it
   * is counted by. It counts nothing: `failed` does, once the attempt has.
   *
   * Between this and `failed` there is a gap, so attempts made at the same
   * instant are all let through before any of them counts. Use `take` where
   * that would matter.
   *
   * @throws `rate_limited`, with how long is left of the stretch.
   */
  async require(budget: Budget, ...who: (string | null)[]): Promise<void> {
    const keys = who.filter((each) => each !== null).map((each) => attemptKey(budget, each));
    if (keys.length === 0) return;
    const now = this.clock.now();
    if (await this.repository.spent(keys, budget.most, now)) throw tooManyAttempts(budget, now);
  }

  /** Counts an attempt that failed. */
  async failed(budget: Budget, who: string | null): Promise<void> {
    if (who === null) return;
    const now = this.clock.now();
    await this.repository.add(attemptKey(budget, who), windowAt(budget, now), budget.most);
  }

  /**
   * Counts an attempt before it is made, in one statement, so that of any
   * number made at once only as many as the budget has left go ahead.
   *
   * @returns What to hand to `giveBack` if the attempt should not count
   *   after all, or `null` where there was no one to count it against.
   * @throws `rate_limited`, with how long is left of the stretch.
   */
  async take(budget: Budget, who: string | null): Promise<Taken | null> {
    if (who === null) return null;
    const now = this.clock.now();
    const taken: Taken = { key: attemptKey(budget, who), window: windowAt(budget, now) };
    if (await this.repository.add(taken.key, taken.window, budget.most)) return taken;
    throw tooManyAttempts(budget, now);
  }

  /** Takes back an attempt that `take` counted: it was good, and only bad ones use a budget up. */
  async giveBack(taken: Taken | null): Promise<void> {
    if (taken !== null) await this.repository.subtract(taken.key, taken.window);
  }

  /** Forgets every count whose stretch is over. The scheduler's pass runs it. */
  prune(): Promise<void> {
    return this.repository.prune(this.clock.now());
  }
}
