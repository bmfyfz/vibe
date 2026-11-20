import { invalid } from "./errors.ts";

/** A channel's path, such as `dev` or `www/production`. It never changes. */
export type ChannelPath = string & { readonly __brand: "ChannelPath" };

const SEGMENT = /^[a-z0-9_-]+$/;
const MAX_PATH_LENGTH = 128;

export function parseChannelPath(input: string): ChannelPath {
  const ok =
    input.length > 0 &&
    input.length <= MAX_PATH_LENGTH &&
    input.split("/").every((segment) => SEGMENT.test(segment));
  if (!ok) {
    throw invalid(
      "invalid_channel",
      `"${input}" is not a channel path.`,
      "Use lowercase letters, numbers, _ and -, in segments joined by /, such as www/production.",
    );
  }
  return input as ChannelPath;
}

/** Where a read, a filter or (later) a grant applies: every channel, one channel, or a subtree. */
export type ChannelPattern =
  | { readonly kind: "all" }
  | { readonly kind: "exact"; readonly path: ChannelPath }
  | { readonly kind: "subtree"; readonly prefix: string };

export const ALL_CHANNELS: ChannelPattern = { kind: "all" };

/** `undefined`, `""` and `*` mean every channel. A trailing slash, as in `www/`, names a subtree. */
export function parseChannelPattern(input: string | undefined): ChannelPattern {
  if (input === undefined || input === "" || input === "*") return ALL_CHANNELS;
  if (input.endsWith("/")) {
    const parent = parseChannelPath(input.slice(0, -1));
    return { kind: "subtree", prefix: `${parent}/` };
  }
  return { kind: "exact", path: parseChannelPath(input) };
}

export function matchesChannel(pattern: ChannelPattern, path: string): boolean {
  if (pattern.kind === "all") return true;
  if (pattern.kind === "exact") return pattern.path === path;
  return path.startsWith(pattern.prefix);
}

/**
 * The half-open range `[low, high)` that holds exactly the paths under a subtree prefix.
 * A range scan needs no wildcard escaping, which `LIKE` would: `_` is legal in a path.
 */
export function subtreeBounds(prefix: string): readonly [low: string, high: string] {
  // "0" is the character after "/", so "www0" is the first string past every "www/…".
  return [prefix, `${prefix.slice(0, -1)}0`];
}

/** A pattern as people write it: `*`, `dev`, or `www/`. */
export function formatChannelPattern(pattern: ChannelPattern): string {
  if (pattern.kind === "all") return "*";
  return pattern.kind === "exact" ? pattern.path : pattern.prefix;
}

/** Whether every channel under `inner` is also under `outer`. */
export function coversPattern(outer: ChannelPattern, inner: ChannelPattern): boolean {
  if (outer.kind === "all") return true;
  if (outer.kind === "exact") return inner.kind === "exact" && inner.path === outer.path;
  if (inner.kind === "exact") return inner.path.startsWith(outer.prefix);
  return inner.kind === "subtree" && inner.prefix.startsWith(outer.prefix);
}

/**
 * Orders patterns from the one that decides first: an exact channel, then the
 * longest subtree, then every channel.
 */
export function compareSpecificity(a: ChannelPattern, b: ChannelPattern): number {
  const rank = (pattern: ChannelPattern) =>
    pattern.kind === "exact"
      ? Number.POSITIVE_INFINITY
      : pattern.kind === "subtree"
        ? pattern.prefix.length
        : 0;
  const [ra, rb] = [rank(a), rank(b)];
  return ra === rb ? 0 : ra > rb ? -1 : 1;
}

/** The channels of a vibe that a caller holds a permission in. Read models filter by it. */
export interface ChannelScope {
  /** `true` when no channel is excluded, so there is nothing to filter. */
  readonly all: boolean;
  allows(channel: string): boolean;
}
