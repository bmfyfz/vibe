import { parseChannelPath } from "@vibe/kernel";

import { invalidSource } from "./errors.ts";

export const PLATFORMS = ["slack", "github", "linear"] as const;
export type PlatformKind = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is PlatformKind {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** How one platform channel is mapped: a Slack channel, a GitHub repository or a Linear team. */
export interface Mapping {
  /** The platform's own name for it, which survives a rename: `C0123ABC`, `acme/www`, a team's ID. */
  readonly platform: string;
  /** How people write it: `#errors`, `acme/www`, `ENG`. */
  readonly label: string;
  /** The vibe channel it syncs with. */
  readonly channel: string;
  /** On GitHub, which of a repository's two kinds of thread this mapping is for. Both, when left out. */
  readonly only?: "pulls" | "issues";
  /** Whether what is written on the vibe goes out to it. */
  readonly out: boolean;
}

/** What a sync entry maps, and what its platform said of the credentials it holds. */
export interface SourceConfig {
  readonly mappings: readonly Mapping[];
  /** Where the platform's API is reached. */
  readonly api: string;
  /** Who the credentials act as on the platform, by the platform's IDs. */
  readonly self: Readonly<Record<string, string>>;
  /** Whether a message can go out under its author's name, where the platform has to allow that. */
  readonly customize: boolean;
}

/** `stopped` is an entry whose service is gone. It syncs nothing until it is made again. */
export type SourceState = "active" | "stopped";

/**
 * A sync entry: one platform account, the channels of it that sync with this
 * vibe's channels, and the service it reads and writes as.
 */
export interface Source {
  readonly id: string;
  readonly vibeId: string;
  /** Its name in the vibe, such as `slack`. */
  readonly key: string;
  readonly platform: PlatformKind;
  /** The service it acts as: `vibe:service:s_…`. */
  readonly principal: string;
  readonly config: SourceConfig;
  readonly state: SourceState;
  readonly reason: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
}

/** What a platform is given to act with. Kept sealed, and never returned. */
export interface Credentials {
  /** The token its API takes: a Slack bot token, a GitHub token, a Linear API key. */
  readonly token: string | null;
  /** The secret its webhooks are signed with. */
  readonly secret: string;
}

/** A vibe holds this many sync entries. Each reads the whole log, and each is a set of credentials. */
export const MAX_SOURCES_PER_VIBE = 32;
/** One entry maps this many platform channels. */
export const MAX_MAPPINGS = 50;

const KEY = /^[a-z][a-z0-9-]{0,31}$/;
/** What `--source` and a message's `from` say for a message written on the vibe. No entry takes it. */
const RESERVED_KEYS = ["vibe"];

/**
 * A sync entry's key: a letter, then up to 31 letters, numbers and hyphens.
 * It is what a target (`slack:#incidents`), a `--source` filter and a
 * message's `from` name the entry by.
 */
export function parseSourceKey(input: string): string {
  const key = input.trim().toLowerCase();
  if (!KEY.test(key) || RESERVED_KEYS.includes(key)) {
    throw invalidSource(
      `"${input}" is not a sync entry's key.`,
      "Start with a letter and use up to 32 letters, numbers and hyphens, such as slack or github-www. `vibe` is taken.",
    );
  }
  return key;
}

/**
 * Where a platform's API is reached, when an entry says so: a GitHub
 * Enterprise Server, or a stand-in for the platform in a test. HTTPS, since
 * the entry's token goes there, or plain HTTP to this machine.
 */
export function parseApiUrl(input: string | undefined, usual: string): string {
  if (input === undefined || input.trim() === "") return usual;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidSource(`"${input}" is not a URL.`, `Leave \`api\` out to use ${usual}.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw invalidSource("A platform's API is reached over https, or http to this machine.");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw invalidSource("A platform's API URL carries no credentials, query or fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

/** Checks a set of mappings as a whole: each channel is a channel, and no platform channel is mapped twice. */
export function assertMappings(mappings: readonly Mapping[]): void {
  if (mappings.length > MAX_MAPPINGS) {
    throw invalidSource(`A sync entry maps up to ${MAX_MAPPINGS} platform channels.`);
  }
  const seen = new Set<string>();
  for (const mapping of mappings) {
    parseChannelPath(mapping.channel);
    const slot = `${mapping.platform}\n${mapping.only ?? ""}`;
    const both = `${mapping.platform}\n`;
    if (seen.has(slot) || seen.has(both) || (mapping.only === undefined && hasKind(seen, both))) {
      throw invalidSource(`${mapping.label} is mapped more than once.`);
    }
    seen.add(slot);
  }
}

function hasKind(seen: ReadonlySet<string>, prefix: string): boolean {
  return [...seen].some((slot) => slot.startsWith(prefix));
}

/**
 * The mapping that says where a platform channel's threads come in.
 *
 * @param only On GitHub, whether the thread is a pull request or an issue.
 */
export function mappingFor(
  config: SourceConfig,
  platformChannel: string,
  only?: "pulls" | "issues",
): Mapping | null {
  return (
    config.mappings.find(
      (mapping) =>
        mapping.platform === platformChannel &&
        (mapping.only === undefined || only === undefined || mapping.only === only),
    ) ?? null
  );
}

/** The mappings through which a new thread in a vibe channel starts a thread on the platform. */
export function startsFrom(config: SourceConfig, channel: string): Mapping[] {
  const starting = new Map<string, Mapping>();
  for (const mapping of config.mappings) {
    if (mapping.channel === channel && mapping.out && !starting.has(mapping.platform)) {
      starting.set(mapping.platform, mapping);
    }
  }
  return [...starting.values()];
}

/** How a platform channel is shown: as people write it when the entry maps it, as the platform names it otherwise. */
export function labelOf(config: SourceConfig, platformChannel: string): string {
  return (
    config.mappings.find((mapping) => mapping.platform === platformChannel)?.label ??
    platformChannel
  );
}
