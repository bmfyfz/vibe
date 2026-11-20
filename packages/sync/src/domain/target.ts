import { invalidTarget } from "./errors.ts";

/** Where a thread is to sync: a sync entry, and a channel or a thread on its platform. */
export interface Target {
  /** The sync entry's key, such as `slack`. */
  readonly key: string;
  /** What follows the key: a platform channel or thread, as people write it. */
  readonly rest: string;
}

/**
 * Reads a target such as `slack:#incidents`, `github:acme/www:123` or
 * `linear:ENG-45`: a sync entry's key, a colon, and a channel or a thread on
 * that entry's platform. What the rest means is the platform's to say.
 */
export function parseTarget(input: string): Target {
  const colon = input.indexOf(":");
  const key = (colon === -1 ? input : input.slice(0, colon)).trim().toLowerCase();
  const rest = colon === -1 ? "" : input.slice(colon + 1).trim();
  if (key === "" || rest === "") {
    throw invalidTarget(
      `"${input}" is not a sync target.`,
      "Name a sync entry and a channel or thread on its platform, such as slack:#incidents or github:acme/www:123. `vibe sources` lists the entries.",
    );
  }
  return { key, rest };
}

/** A platform place a target settled on. */
export interface Place {
  /** The platform channel: a Slack channel's ID, `owner/repo`, a Linear team's ID. */
  readonly channel: string;
  /** The platform thread to join, or `null` to start a new one in the channel. */
  readonly thread: string | null;
  /** The platform's link to the thread, when it exists and is known. */
  readonly url: string | null;
}

/** A target as it is shown: the entry's key and the platform thread, or the channel while there is none. */
export function formatTarget(key: string, channelLabel: string, thread: string | null): string {
  return `${key}:${thread ?? channelLabel}`;
}

/**
 * A link a platform gave, kept only when it is a web address. A platform's
 * payload is someone else's text, and a client may open what it is handed.
 */
export function webLink(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length > 2000) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
