import type { TaskDetail } from "@vibe/contracts";
import type { ChannelPattern, ChannelScope, LabelFilter, UnitOfWork } from "@vibe/kernel";

import type { Task, TaskState } from "../domain/task.ts";

/** Where a task is, for the sweep and for workers looking for one. */
export interface TaskPlace {
  id: string;
  vibeId: string;
  channel: string;
}

export interface ClaimableQuery {
  vibeId: string;
  channel: ChannelPattern;
  /** Labels the task's root must carry, every one. */
  labels: readonly LabelFilter[];
  /** The worker's principal: it takes the tasks its own actors own. */
  principal: string;
  /** The worker's profile, which also takes the tasks kept for it. */
  profile: string | null;
  /** Other owners, by actor ID, whose unassigned tasks it takes too. */
  from: readonly string[];
  now: number;
  limit: number;
  offset: number;
}

export interface TaskRepository {
  find(vibeId: string, id: string): Promise<Task | null>;
  /** Adds the task as it now stands to a unit of work. A new task must not exist yet. */
  save(uow: UnitOfWork, task: Task): void;
  /** Whether a failed commit found the thread already was a task. */
  isTaken(error: unknown): boolean;
  /**
   * Whether a commit failed because it would have left tasks waiting for
   * each other: what another task waits for changed between the check and
   * the commit. Nothing was written, and deciding again finds the circle.
   */
  closedCircle(error: unknown): boolean;
  /** The state and channel of each task that exists, among these IDs. */
  statesOf(
    vibeId: string,
    ids: readonly string[],
  ): Promise<Map<string, { state: TaskState; channel: string }>>;
  /** Whether a task still waits for one that hasn't completed. */
  hasUnmet(id: string): Promise<boolean>;
  /** Whether following what `from` wait for, and what those wait for, leads to `target`. */
  reaches(from: readonly string[], target: string): Promise<boolean>;
  /** Waiting tasks with nothing left to wait for: those needing one task, some among a few, or any. */
  promotable(
    where: { needing?: string; among?: readonly string[] },
    limit: number,
  ): Promise<TaskPlace[]>;
  /** Claimed tasks whose lease has run out. */
  expired(now: number, limit: number): Promise<TaskPlace[]>;
  /**
   * Tasks a worker could claim now, in the order a queue works them: those kept
   * for the worker first, then the oldest.
   */
  claimable(query: ClaimableQuery): Promise<TaskPlace[]>;
}

export interface TaskFilter {
  channel: ChannelPattern;
  /** The states to list, or `null` for every one. */
  states: readonly TaskState[] | null;
  /** A handle or an actor ID: tasks that actor owns. A person's handle covers their profiles. */
  by?: string | undefined;
  /** Tasks kept for this profile. */
  for?: string | undefined;
  labels?: readonly LabelFilter[] | undefined;
  limit: number;
}

/** The read side: tasks as the API shows them, with their root messages. */
export interface TaskQueries {
  /** A task by its thread, with a lease that has run out shown as ready. */
  get(vibeId: string, id: string, now: number): Promise<TaskDetail | null>;
  /** Several tasks, in the order asked for. Ones that don't exist are left out. */
  getMany(vibeId: string, ids: readonly string[], now: number): Promise<TaskDetail[]>;
  /** A vibe's tasks that match, oldest first, among the channels in `scope`. */
  list(vibeId: string, filter: TaskFilter, scope: ChannelScope, now: number): Promise<TaskDetail[]>;
}
