import type { ActorDirectory, Caller } from "@vibe/identity";
import type { BeginUnitOfWork, Clock, EventLog } from "@vibe/kernel";
import { type Thread, type ThreadRepository, toRecords, writeConflict } from "@vibe/messaging";

import { type Task, TASK_LABEL, type TaskEvent, type TaskSnapshot } from "../domain/task.ts";
import type { TaskRepository } from "./ports.ts";

// Each attempt loads fresh state, decides again, and commits. A commit that
// loses a race writes nothing, so trying again is always safe.
const MAX_ATTEMPTS = 8;

/**
 * Records what happened to a task on its thread, so each change takes the
 * thread's next version and the root's `vibe.task` label follows the state.
 */
export function noteOnThread(thread: Thread, events: readonly TaskEvent[], now: number): void {
  for (const event of events) {
    thread.note({
      as: event.type,
      actorId: event.actorId,
      payload: event.payload,
      labels: { [TASK_LABEL]: event.state },
      now,
    });
  }
}

/** How every change to a task that already exists is made. */
export class TaskChanges {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly threads: ThreadRepository,
    private readonly eventLog: EventLog,
    private readonly actors: ActorDirectory,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Loads a task and its thread, lets `decide` change the task, and commits
   * the task, the thread and the events as one. The thread's version guards
   * all of it: when another writer gets there first nothing is written, and
   * the change is decided again from what that writer left.
   *
   * @param by Who makes the change, when someone does: a profile's first write introduces it.
   * @returns The task as the change left it, or `null` when there is no such task.
   */
  async apply(
    vibeId: string,
    taskId: string,
    decide: (task: Task, now: number) => void | Promise<void>,
    by?: Caller,
  ): Promise<TaskSnapshot | null> {
    const { tasks, threads, eventLog, actors, begin, clock } = this;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // The thread first: a change to the task after this read bumps the
      // version read here, and the commit below fails.
      const thread = await threads.findByMessage(vibeId, taskId);
      const task = thread?.id === taskId ? await tasks.find(vibeId, taskId) : null;
      if (!thread || !task) return null;

      const now = clock.now();
      await decide(task, now);
      const happened = task.pullEvents();
      if (happened.length === 0) return task.snapshot;

      noteOnThread(thread, happened, now);
      const events = thread.pullEvents();
      const uow = begin();
      eventLog.append(uow, toRecords(thread, events));
      threads.save(uow, thread, events);
      tasks.save(uow, task);
      if (by) actors.introduce(uow, by, now);
      try {
        await uow.commit();
        return task.snapshot;
      } catch (error) {
        // Lost a race for the thread, or for what tasks wait for: decided again.
        if (!eventLog.isVersionConflict(error) && !tasks.closedCircle(error)) throw error;
      }
    }
    throw writeConflict();
  }
}
