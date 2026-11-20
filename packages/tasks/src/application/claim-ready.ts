import type { Authorizer, Caller } from "@vibe/identity";
import {
  type Clock,
  DomainError,
  invalid,
  type LabelFilter,
  parseChannelPattern,
  type Sleep,
} from "@vibe/kernel";
import type { VibeRecord } from "@vibe/messaging";

import type { ChangeTask, ClaimedTask } from "./change-task.ts";
import type { TaskRepository } from "./ports.ts";

export interface ClaimReadyCommand {
  caller: Caller;
  vibe: VibeRecord;
  /** A channel, or a subtree such as `work/`. */
  channel: string | undefined;
  /** Labels the task's root must carry, every one. This is how work is routed. */
  labels: readonly LabelFilter[];
  /** Other owners, by actor ID, whose tasks to take too. */
  from: readonly string[];
  /** How long to wait for a task to become ready. */
  waitMs: number;
  leaseMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

// A task's text is instructions for whoever claims it, so a worker takes only
// its own principal's tasks until it names the owners it takes from.
const MAX_OWNERS = 10;
// Candidates are read a page at a time, and the ones the caller may not
// claim are passed over. The reading goes on to the end of the queue: a cap
// on it would hide a task that sits behind enough others the caller can't
// read, on every poll alike.
const PAGE = 100;

/** These mean another worker got the task first, or it left the queue. Try the next one. */
const GONE = new Set([
  "task_claimed",
  "task_assigned",
  "task_waiting",
  "task_blocked",
  "task_finished",
  "task_not_found",
]);

/** Claims the next task of a queue: the oldest ready one that matches, kept-for-this-worker first. */
export class ClaimReady {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly changeTask: ChangeTask,
    private readonly authorizer: Authorizer,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    /** How often a waiting worker looks again. Each look is one indexed query. */
    private readonly pollIntervalMs: number,
  ) {}

  /** @returns The claimed task, or `null` when none is ready, or none became ready in time. */
  async execute(command: ClaimReadyCommand): Promise<ClaimedTask | null> {
    const { caller, vibe, signal } = command;
    const channel = parseChannelPattern(command.channel);
    if (command.from.length > MAX_OWNERS || command.from.some((id) => !id.startsWith("vibe:"))) {
      throw invalid(
        "invalid_task",
        `Name up to ${MAX_OWNERS} owners to take from, each by actor ID.`,
        "`vibe actors` lists actor IDs.",
      );
    }
    // Claiming takes `read` and `label`. Fixed for the request, like a feed's scope.
    const [readable, labelable] = await Promise.all([
      this.authorizer.scope(caller, vibe.id, "read"),
      this.authorizer.scope(caller, vibe.id, "label"),
    ]);
    const deadline = this.clock.now() + command.waitMs;

    for (;;) {
      for (let page = 0; ; page++) {
        const candidates = await this.tasks.claimable({
          vibeId: vibe.id,
          channel,
          labels: command.labels,
          principal: caller.principal,
          profile: caller.profile,
          from: command.from,
          now: this.clock.now(),
          limit: PAGE,
          offset: page * PAGE,
        });
        for (const candidate of candidates) {
          if (!readable.allows(candidate.channel) || !labelable.allows(candidate.channel)) continue;
          try {
            return await this.changeTask.claim({
              caller,
              vibe,
              taskId: candidate.id,
              leaseMs: command.leaseMs,
            });
          } catch (error) {
            if (!(error instanceof DomainError && GONE.has(error.code))) throw error;
          }
        }
        if (candidates.length < PAGE) break;
      }

      const remaining = deadline - this.clock.now();
      if (remaining <= 0 || signal?.aborted) return null;
      await this.sleep(Math.min(this.pollIntervalMs, remaining), signal);
    }
  }
}
