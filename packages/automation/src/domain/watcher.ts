import {
  type ChannelPattern,
  formatChannelPattern,
  type LabelFilter,
  newSecret,
  parseChannelPattern,
  parseLabelFilters,
  profileActorId,
} from "@vibe/kernel";

import { invalidWatcher } from "./errors.ts";

/** `stopped` is a watcher whose registrant is gone. A stopped watcher is never delivered to again. */
export type WatcherState = "active" | "stopped";

/** What a watcher follows, as it is stored: the filters of `vibe tail`, already settled. */
export interface StoredTail {
  /** A channel pattern as people write it: `*`, `dev`, or `www/`. */
  readonly channel: string;
  /** Only events in the thread with this root. */
  readonly re: string | null;
  /** A handle or an actor ID: only events about that author's messages. */
  readonly by: string | null;
  /** Label filters as people write them, such as `state=open|draft`. Every one must match. */
  readonly labels: readonly string[];
  /** An actor ID: only events about messages that mention that actor. */
  readonly mentions: string | null;
  /** A sync entry's key, or `vibe`: only events about messages from there. Absent on a watcher made before there was sync. */
  readonly source?: string | null | undefined;
  /** Include the events that only keep the books. */
  readonly all: boolean;
}

/** What a watcher follows, as the event log reads it. */
export interface TailFilter {
  channel: ChannelPattern;
  re?: string | undefined;
  by?: string | undefined;
  labels: readonly LabelFilter[];
  mentions?: string | undefined;
  source?: string | undefined;
  all: boolean;
}

export interface Watcher {
  readonly id: string;
  readonly vibeId: string;
  /** Its name in the vibe, and the profile it writes as. */
  readonly name: string;
  readonly url: string;
  readonly tail: StoredTail;
  /** Signs each delivery. */
  readonly secret: string;
  /** Who registered it. */
  readonly actorId: string;
  /** Whose access it reads with. */
  readonly principal: string;
  readonly state: WatcherState;
  readonly reason: string | null;
  readonly createdAt: number;
}

/** A vibe holds this many watchers. Each is a request to somewhere on every matching write. */
export const MAX_WATCHERS_PER_VIBE = 32;
const MAX_URL_LENGTH = 2000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * A watcher's name. It doubles as the profile the watcher writes as, so it is
 * spelled as a profile is: a letter, then up to 31 letters, numbers and hyphens.
 */
export function parseWatcherName(input: string): string {
  const name = input.trim().toLowerCase();
  if (!NAME.test(name)) {
    throw invalidWatcher(
      `"${input}" is not a watcher's name.`,
      "Start with a letter and use up to 32 letters, numbers and hyphens, such as triage.",
    );
  }
  return name;
}

/**
 * Where a watcher's deliveries go. HTTPS, since each carries what the watcher
 * can read. Plain HTTP only to this machine, which is how a local Vibe reaches
 * a local receiver.
 */
export function parseWatcherUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidWatcher(`"${input}" is not a URL.`, "Such as https://example.com/hooks/vibe.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw invalidWatcher(
      "A watcher's URL is https, or http to this machine.",
      "Such as https://example.com/hooks/vibe, or http://localhost:3000/hooks/vibe.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw invalidWatcher(
      "A watcher's URL carries no credentials.",
      "Check the signature of each delivery instead: it proves the delivery is Vibe's.",
    );
  }
  if (url.href.length > MAX_URL_LENGTH) {
    throw invalidWatcher(`A watcher's URL holds up to ${MAX_URL_LENGTH} characters.`);
  }
  return url.href;
}

/** Settles what a watcher follows, refusing a pattern or a label filter that isn't one. */
export function settleTail(input: {
  channel?: string | undefined;
  re?: string | undefined;
  by?: string | undefined;
  labels?: readonly string[] | undefined;
  mentions?: string | undefined;
  source?: string | undefined;
  all?: boolean | undefined;
}): StoredTail {
  const labels = [...(input.labels ?? [])];
  parseLabelFilters(labels);
  return {
    channel: formatChannelPattern(parseChannelPattern(input.channel)),
    re: input.re ?? null,
    by: input.by ?? null,
    labels,
    mentions: input.mentions ?? null,
    source: input.source?.trim().toLowerCase() || null,
    all: input.all === true,
  };
}

export function filterOf(tail: StoredTail): TailFilter {
  return {
    channel: parseChannelPattern(tail.channel),
    re: tail.re ?? undefined,
    by: tail.by ?? undefined,
    labels: parseLabelFilters(tail.labels),
    mentions: tail.mentions ?? undefined,
    source: tail.source ?? undefined,
    all: tail.all,
  };
}

/**
 * The actor a watcher writes as: whoever registered it, under the watcher's
 * name as a profile. What that actor does never wakes the watcher, so a
 * receiver that answers in the thread it was told about doesn't hear itself.
 * Other watchers do hear it.
 */
export function watcherActor(watcher: Pick<Watcher, "principal" | "name">): string {
  return profileActorId(watcher.principal, watcher.name);
}

export function newWatcherSecret(): string {
  return newSecret("vibe_whsec");
}

// How long to leave a failing endpoint alone, by how many attempts have failed
// in a row. It ends at an hour and stays there: a delivery is never given up on.
const BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];

/** The wait before the next attempt, after `attempts` have failed in a row. */
export function backoffMs(attempts: number): number {
  const last = BACKOFF_MS.length - 1;
  return BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, last)] ?? 3_600_000;
}

/**
 * Signs a delivery: HMAC-SHA256, keyed with the watcher's secret, over the
 * timestamp, a dot, and the body exactly as sent. The timestamp is signed
 * too, so a delivery someone recorded can't be replayed later as new.
 *
 * @param timestamp Seconds since the epoch, as sent in `Vibe-Timestamp`.
 * @returns The value of `Vibe-Signature`: `v1=` and the signature in hex.
 */
export async function signDelivery(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const encode = (text: string) => new TextEncoder().encode(text);
  const key = await crypto.subtle.importKey(
    "raw",
    encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, encode(`${timestamp}.${body}`));
  const hex = Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0"));
  return `v1=${hex.join("")}`;
}
