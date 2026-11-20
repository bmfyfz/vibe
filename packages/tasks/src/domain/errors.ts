import { conflict, forbidden, invalid, notFound } from "@vibe/kernel";

export const taskNotFound = (id: string) =>
  notFound("task_not_found", `No task has the ID ${id}, or you can't read it.`);

export const taskExists = (id: string) =>
  conflict("task_exists", `The thread ${id} is already a task.`);

export const claimLost = () =>
  conflict(
    "claim_lost",
    "Your claim on this task is over: its lease ran out, or the task was released, held or canceled.",
    "Nothing changed. Claim the task again if it is still ready.",
  );

export const taskClaimed = () =>
  conflict(
    "task_claimed",
    "Another worker holds this task.",
    "It becomes ready again when that worker releases it or its lease runs out.",
  );

export const taskAssigned = (profile: string) =>
  conflict(
    "task_assigned",
    `This task is kept for the ${profile} profile of its owner.`,
    "Its owner can return it to the pool with `vibe tasks assign <id> --pool`.",
  );

export const taskWaiting = () =>
  conflict("task_waiting", "This task waits for another task that hasn't completed.");

export const taskBlocked = () =>
  conflict(
    "task_blocked",
    "This task is held for a person.",
    "Its owner lifts the hold with `vibe tasks unblock <id>`.",
  );

export const taskFinished = (state: string) =>
  conflict(
    "task_finished",
    `This task is ${state}, so it can't change.`,
    state === "failed" ? "Its owner can retry it with `vibe tasks reopen <id>`." : undefined,
  );

export const taskNotBlocked = () => conflict("task_not_blocked", "This task isn't held.");

export const taskNotFailed = () =>
  conflict("task_not_failed", "Only a failed task can be reopened.");

export const taskNotOwned = () =>
  forbidden(
    "task_not_owned",
    "This change is for the task's owner, or for someone with manage in its channel.",
    "As yourself you manage the tasks your profiles created. As a profile, only its own.",
  );

export const invalidNeeds = (message: string) =>
  invalid(
    "invalid_needs",
    message,
    "A task can wait for tasks you can read, and tasks can't wait for each other.",
  );

export const invalidTask = (message: string, hint?: string) =>
  invalid("invalid_task", message, hint);
