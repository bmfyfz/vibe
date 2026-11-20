import type { ActorDirectory, Authorizer } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type Clock,
  type EventLog,
  type Sleep,
  sleep,
  systemClock,
} from "@vibe/kernel";
import type { Messaging } from "@vibe/messaging";
import type { Db } from "@vibe/store";

import { ChangeTask } from "./application/change-task.ts";
import { TaskChanges } from "./application/changes.ts";
import { ClaimReady } from "./application/claim-ready.ts";
import { CreateTasks } from "./application/create-tasks.ts";
import { TaskFollower } from "./application/follow.ts";
import type { TaskQueries } from "./application/ports.ts";
import { TaskSweep } from "./application/sweep.ts";
import { DrizzleTaskQueries } from "./infrastructure/drizzle-task-queries.ts";
import { DrizzleTaskRepository } from "./infrastructure/drizzle-task-repository.ts";

export type { ClaimedTask } from "./application/change-task.ts";
export type { ClaimReadyCommand } from "./application/claim-ready.ts";
export type {
  AdoptThreadCommand,
  CreatedTasks,
  CreateTasksCommand,
  NewTask,
} from "./application/create-tasks.ts";
export type { TaskFilter, TaskQueries } from "./application/ports.ts";
export { taskNotFound } from "./domain/errors.ts";
export { MAX_TASKS_PER_WRITE } from "./domain/plan.ts";
export {
  type Claim,
  FINISHED_STATES,
  MAX_LEASE_MS,
  OPEN_STATES,
  TASK_LABEL,
  TASK_STATES,
  type TaskSnapshot,
  type TaskState,
} from "./domain/task.ts";

export interface Tasks {
  create: CreateTasks;
  change: ChangeTask;
  claimReady: ClaimReady;
  /** What the scheduler runs each minute: lapsed leases and tasks with nothing left to wait for. */
  sweep: TaskSweep;
  queries: TaskQueries;
}

/**
 * Wires the Tasks context. A task is a thread, so this context builds on
 * Messaging: it records its changes on threads, and follows changes to them.
 */
export function createTasks(deps: {
  db: Db;
  begin: BeginUnitOfWork;
  eventLog: EventLog;
  authorizer: Authorizer;
  actors: ActorDirectory;
  messaging: Messaging;
  clock?: Clock | undefined;
  sleep?: Sleep | undefined;
  pollIntervalMs?: number | undefined;
}): Tasks {
  const { messaging, authorizer } = deps;
  const clock = deps.clock ?? systemClock;
  const repository = new DrizzleTaskRepository(deps.db);
  const changes = new TaskChanges(
    repository,
    messaging.threads,
    deps.eventLog,
    deps.actors,
    deps.begin,
    clock,
  );
  const sweep = new TaskSweep(repository, changes, clock);
  const change = new ChangeTask(repository, changes, authorizer, sweep);
  messaging.followers.add(new TaskFollower(repository));

  return {
    create: new CreateTasks(
      repository,
      messaging.threads,
      messaging.attachments,
      messaging.idempotency,
      messaging.actors,
      deps.eventLog,
      authorizer,
      deps.actors,
      sweep,
      deps.begin,
      clock,
    ),
    change,
    claimReady: new ClaimReady(
      repository,
      change,
      authorizer,
      clock,
      deps.sleep ?? sleep,
      deps.pollIntervalMs ?? 1000,
    ),
    sweep,
    queries: new DrizzleTaskQueries(deps.db),
  };
}
