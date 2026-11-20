import type { TaskChanges } from "./changes.ts";
import type { TaskPlace, TaskRepository } from "./ports.ts";

/**
 * The tidying a clock and a completion leave to do. Nothing here is needed for
 * correctness: a claim whose lease has run out already counts as over, and a
 * task that waits for nothing is readied the next time this runs. It keeps the
 * `vibe.task` label and the event feed in step with what is already true.
 */
export class TaskSweep {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly changes: TaskChanges,
    private readonly clock: { now(): number },
  ) {}

  /** Readies waiting tasks whose prerequisites have all completed. */
  async promote(
    where: { needing?: string; among?: readonly string[] } = {},
    limit = 50,
  ): Promise<number> {
    const { tasks, changes } = this;
    let promoted = 0;
    for (const place of await tasks.promotable(where, limit)) {
      const before = promoted;
      await changes.apply(place.vibeId, place.id, async (task, now) => {
        // Decided from fresh state: a prerequisite may have been swapped in since.
        if (await tasks.hasUnmet(task.id)) return;
        if (task.promote({ actorId: task.snapshot.owner, now })) promoted = before + 1;
      });
    }
    return promoted;
  }

  /** Returns tasks whose lease ran out to the queue, and says so in the feed. */
  async expire(limit = 100): Promise<number> {
    const { tasks, changes, clock } = this;
    let expired = 0;
    for (const place of await tasks.expired(clock.now(), limit)) {
      const before = expired;
      await changes.apply(place.vibeId, place.id, (task, now) => {
        if (task.expire({ now })) expired = before + 1;
      });
    }
    return expired;
  }

  /** One pass of both, as the scheduler runs it each minute. */
  async run(): Promise<{ expired: number; promoted: number }> {
    return { expired: await this.expire(), promoted: await this.promote() };
  }

  /**
   * The same promotion, when failing must not fail what triggered it: a task
   * that has completed stays completed even if readying what waited for it
   * has to wait for the next pass.
   */
  async promoteQuietly(where: { needing?: string; among?: readonly string[] }): Promise<void> {
    try {
      await this.promote(where);
    } catch (error) {
      console.error("Readying waiting tasks failed; the next sweep will retry.", error);
    }
  }
}

export type { TaskPlace };
