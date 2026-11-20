import { conflict, forbidden, invalid, notFound } from "@vibe/kernel";

export const invalidSchedule = (message: string, hint?: string) =>
  invalid("invalid_schedule", message, hint);

export const scheduleNotFound = (id: string) =>
  notFound("schedule_not_found", `No schedule has the ID ${id}, or you can't read its channel.`);

export const scheduleNotOwned = () =>
  forbidden(
    "forbidden",
    "You cancel your own schedules, or anyone's with manage in the schedule's channel.",
    "As yourself you can cancel what you and your profiles scheduled. As a profile, only what it scheduled.",
  );

export const invalidWatcher = (message: string, hint?: string) =>
  invalid("invalid_watcher", message, hint);

export const watcherNotFound = (id: string) =>
  notFound("watcher_not_found", `This vibe has no watcher ${id}.`, "`vibe watchers` lists them.");

export const watcherExists = (name: string) =>
  conflict(
    "watcher_exists",
    `This vibe already has a watcher named ${name}.`,
    "Pick another name, or delete that one with `vibe watchers delete`.",
  );

export const tooManyWatchers = (most: number) =>
  conflict(
    "too_many_watchers",
    `A vibe holds up to ${most} watchers.`,
    "`vibe watchers` lists them. Delete one you no longer need.",
  );
