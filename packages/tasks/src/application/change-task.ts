import { type Authorizer, type Caller, parseProfile } from "@vibe/identity";
import { newId } from "@vibe/kernel";
import type { VibeRecord } from "@vibe/messaging";

import { invalidNeeds, taskNotFound } from "../domain/errors.ts";
import type { Claim, Task, TaskSnapshot } from "../domain/task.ts";
import type { TaskChanges } from "./changes.ts";
import type { TaskRepository } from "./ports.ts";
import type { TaskSweep } from "./sweep.ts";

interface TaskCommand {
  caller: Caller;
  vibe: VibeRecord;
  taskId: string;
}

/** A command from the worker that holds the task. */
interface HolderCommand extends TaskCommand {
  claimId: string;
}

export interface ClaimedTask {
  task: TaskSnapshot;
  claim: Claim;
}

/** Whether the caller's grants let it manage the task's channel. */
interface Standing {
  manager: boolean;
  now: number;
}

/** Every change to one task: a worker's, and its owner's. */
export class ChangeTask {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly changes: TaskChanges,
    private readonly authorizer: Authorizer,
    private readonly sweep: TaskSweep,
  ) {}

  /** Claims a task by its ID, for a lease. Of two workers that try at once, one gets it. */
  async claim(command: TaskCommand & { leaseMs?: number | undefined }): Promise<ClaimedTask> {
    const { caller, leaseMs } = command;
    let claim: Claim | undefined;
    const task = await this.change(command, "worker", (task, { now }) => {
      claim = task.claim({ by: caller, claimId: newId("clm", now), leaseMs, now });
    });
    if (!claim) throw taskNotFound(command.taskId);
    return { task, claim };
  }

  /** Extends the holder's lease from now. */
  async renew(command: HolderCommand & { leaseMs?: number | undefined }): Promise<Claim> {
    const { caller, claimId, leaseMs } = command;
    let claim: Claim | undefined;
    await this.change(command, "worker", (task, { now }) => {
      claim = task.renew({ by: caller, claimId, leaseMs, now });
    });
    if (!claim) throw taskNotFound(command.taskId);
    return claim;
  }

  release(command: HolderCommand): Promise<TaskSnapshot> {
    const { caller, claimId } = command;
    return this.change(command, "worker", (task, { now }) => {
      task.release({ by: caller, claimId, now });
    });
  }

  /** Finishes the task, and readies the tasks that waited only for it. */
  async complete(command: HolderCommand & { result?: string | undefined }): Promise<TaskSnapshot> {
    const { caller, claimId, result } = command;
    const task = await this.change(command, "worker", (task, { now }) => {
      task.complete({ by: caller, claimId, result, now });
    });
    await this.sweep.promoteQuietly({ needing: task.id });
    return task;
  }

  fail(command: HolderCommand & { reason: string }): Promise<TaskSnapshot> {
    const { caller, claimId, reason } = command;
    return this.change(command, "worker", (task, { now }) => {
      task.fail({ by: caller, claimId, reason, now });
    });
  }

  /** Holds the task for a person: the worker with its claim, or the owner without one. */
  block(
    command: TaskCommand & {
      claimId?: string | undefined;
      reason: string;
      kind?: string | undefined;
    },
  ): Promise<TaskSnapshot> {
    const { caller, claimId, reason, kind } = command;
    return this.change(command, claimId === undefined ? "owner" : "worker", (task, standing) => {
      task.block({ by: caller, claimId, reason, kind, ...standing });
    });
  }

  unblock(command: TaskCommand): Promise<TaskSnapshot> {
    return this.settleWaiting(command, async (task, standing) => {
      task.unblock({ by: command.caller, unmet: await this.tasks.hasUnmet(task.id), ...standing });
    });
  }

  reopen(command: TaskCommand): Promise<TaskSnapshot> {
    return this.settleWaiting(command, async (task, standing) => {
      task.reopen({ by: command.caller, unmet: await this.tasks.hasUnmet(task.id), ...standing });
    });
  }

  /** Keeps the task for one profile of its owner, or with `null` returns it to the pool. */
  assign(command: TaskCommand & { profile: string | null }): Promise<TaskSnapshot> {
    const profile = command.profile === null ? null : parseProfile(command.profile);
    return this.change(command, "owner", (task, standing) => {
      task.assign({ by: command.caller, profile, ...standing });
    });
  }

  /** Replaces what the task waits for. Each must be a task the caller can read, and none may wait for this one. */
  setNeeds(command: TaskCommand & { needs: readonly string[] }): Promise<TaskSnapshot> {
    const { caller, vibe, taskId } = command;
    const needs = [...new Set(command.needs)];
    return this.settleWaiting(command, async (task, standing) => {
      const [states, scope] = await Promise.all([
        this.tasks.statesOf(vibe.id, needs),
        this.authorizer.scope(caller, vibe.id),
      ]);
      for (const need of needs) {
        const found = states.get(need);
        if (need !== taskId && (!found || !scope.allows(found.channel))) {
          throw invalidNeeds(`${need} is not a task you can read.`);
        }
      }
      if (await this.tasks.reaches(needs, taskId)) {
        throw invalidNeeds("Tasks can't wait for each other.");
      }
      const unmet = needs.some((need) => states.get(need)?.state !== "completed");
      task.setNeeds({ by: caller, needs, unmet, ...standing });
    });
  }

  cancel(command: TaskCommand & { reason: string }): Promise<TaskSnapshot> {
    return this.change(command, "owner", (task, standing) => {
      task.cancel({ by: command.caller, reason: command.reason, ...standing });
    });
  }

  /**
   * A change that can leave the task waiting. What it waited for may complete
   * between the decision and the commit, so the task is looked at once more.
   */
  private async settleWaiting(
    command: TaskCommand,
    decide: (task: Task, standing: Standing) => Promise<void>,
  ): Promise<TaskSnapshot> {
    const task = await this.change(command, "owner", decide);
    if (task.state !== "waiting") return task;
    await this.sweep.promoteQuietly({ among: [task.id] });
    return (await this.tasks.find(command.vibe.id, task.id))?.snapshot ?? task;
  }

  /**
   * Runs one change against a task the caller can read. A worker's change also
   * takes `label` in the task's channel, and so does any change by a caller
   * under a limit; an owner's is checked by the task itself, which is told
   * whether the caller manages the channel.
   */
  private async change(
    command: TaskCommand,
    as: "worker" | "owner",
    decide: (task: Task, standing: Standing) => void | Promise<void>,
  ): Promise<TaskSnapshot> {
    const { caller, vibe, taskId } = command;
    const after = await this.changes.apply(
      vibe.id,
      taskId,
      async (task, now) => {
        const resource = { vibeId: vibe.id, channel: task.snapshot.channel };
        const can = await this.authorizer.permissions(caller, resource);
        // A task the caller can't read is, to them, not there.
        if (!can.has("read")) throw taskNotFound(taskId);
        // Owning a task is enough to change it, where the owner can read. A
        // caller under a limit also needs `label`, as a worker does: a limit
        // that says "read" must not cancel its principal's tasks.
        if ((as === "worker" || caller.narrowed !== null) && !can.has("label")) {
          await this.authorizer.require(caller, "label", resource);
        }
        await decide(task, { manager: can.has("manage"), now });
      },
      caller,
    );
    if (!after) throw taskNotFound(taskId);
    return after;
  }
}
