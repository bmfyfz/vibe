import { conflict, forbidden, invalid, notFound, unauthorized, unavailable } from "@vibe/kernel";

export const invalidSource = (message: string, hint?: string) =>
  invalid("invalid_source", message, hint);

export const sourceNotFound = (key: string) =>
  notFound("source_not_found", `This vibe has no sync entry ${key}.`, "`vibe sources` lists them.");

export const sourceExists = (key: string) =>
  conflict(
    "source_exists",
    `This vibe already has a sync entry named ${key}.`,
    "Pick another key, or delete that one with `vibe sources delete`.",
  );

export const tooManySources = (most: number) =>
  conflict("too_many_sources", `A vibe holds up to ${most} sync entries.`);

export const invalidTarget = (message: string, hint?: string) =>
  invalid("invalid_target", message, hint);

export const alreadySynced = () =>
  conflict(
    "already_synced",
    "That platform thread already syncs with another thread of this vibe.",
    "A platform thread syncs with one thread only. `vibe sync <id>` shows where a thread is synced.",
  );

export const threadNotSynced = () =>
  conflict(
    "no_sync",
    "This thread's root was posted with noSync, which keeps the whole thread off every platform.",
    "Start another thread for what may leave the vibe.",
  );

export const ownersOnly = (what: string) =>
  forbidden("forbidden", `Only a team owner can ${what}.`);

export const syncUnavailable = () =>
  unavailable(
    "sync_unavailable",
    "This Vibe has no key to keep platform credentials under, so it can't sync.",
    "Start it with VIBE_ADMIN_SECRET set: the key is derived from it.",
  );

/** A webhook that isn't the platform's: its signature is missing, wrong, or too old. */
export const webhookRefused = (why: string) => unauthorized("webhook_refused", why);

/** A platform's API didn't do what was asked. Worth trying again later. */
export const platformFailed = (message: string, hint?: string) =>
  unavailable("platform_unavailable", message, hint);
