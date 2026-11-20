import type { Alongside, ThreadChange, ThreadFollower } from "@vibe/messaging";

import { noteOnThread } from "./changes.ts";
import type { TaskRepository } from "./ports.ts";

/**
 * Keeps a task in step with its root message. A task's text is instructions
 * for whoever claims it, so the text can't be deleted or changed under it:
 * deleting the root cancels the task, and an edit by anyone but its owner
 * holds it. Both land in the same commit as the change to the message.
 */
export class TaskFollower implements ThreadFollower {
  constructor(private readonly tasks: TaskRepository) {}

  async follow({ thread, events, caller, now }: ThreadChange): Promise<Alongside | null> {
    const toRoot = events.find(
      (event) =>
        event.messageId === thread.id &&
        (event.type === "message.deleted" || event.type === "message.edited"),
    );
    if (!toRoot) return null;
    const task = await this.tasks.find(thread.snapshot.vibeId, thread.id);
    if (!task) return null;

    const changed =
      toRoot.type === "message.deleted"
        ? task.rootDeleted({ actorId: caller.actorId, now })
        : task.rootEdited({ by: caller, now });
    if (!changed) return null;

    noteOnThread(thread, task.pullEvents(), now);
    return (uow) => this.tasks.save(uow, task);
  }
}
