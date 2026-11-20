import type {
  SyncedView,
  SyncInboxEntry,
  SyncMapInput,
  SyncPlatform,
  SyncSource,
  VibeHandle,
} from "@vibe/sdk";

import { ago } from "./format.ts";
import { integer, UsageError } from "./shared.ts";

export interface SyncSession {
  flags: {
    platform?: string | undefined;
    service?: string[] | undefined;
    map?: string[] | undefined;
    replies?: boolean | undefined;
    api?: string | undefined;
    credentials?: string | undefined;
    limit?: string | undefined;
    json?: boolean | undefined;
  };
  /** Where the Vibe is served, to say where a platform's webhooks go. */
  url: string | undefined;
  client(): VibeHandle;
  out(human: string, data: unknown): void;
}

const SYNC_USAGE = `Usage: vibe sync <id>            Show where a thread is synced
       vibe sync <id> <target>   Sync it with a platform: slack:#incidents starts a thread there,
                                 slack:C0123ABC:1700000000.000100, github:acme/www:123 and
                                 linear:ENG-45 join one that exists`;

const SOURCES_USAGE = `Usage: vibe sources                List the vibe's sync entries
       vibe sources create <key> --platform <slack|github|linear> --service <NAME>
                    --map <PLATFORM-CHANNEL=CHANNEL>... [--replies] [--api <URL>]
                    [--credentials <FILE>]
                                   Add one, as a team owner. Its token and its webhook secret
                                   are read from VIBE_SYNC_TOKEN and VIBE_SYNC_SECRET, or from a
                                   JSON file: { "token": "…", "secret": "…" }
       vibe sources credentials <key> [--credentials <FILE>]
                                   Replace its token, its webhook secret, or both, from the same
                                   places. What isn't given stays as it is
       vibe sources delete <key>   Remove one, and its records of what is synced where`;

/** `vibe sync`: where a thread is synced, or sync it with a platform thread. */
export async function sync({ client, out }: SyncSession, args: string[]): Promise<number> {
  const [id, target] = args;
  if (!id?.startsWith("msg_")) throw new UsageError(SYNC_USAGE);
  if (target === undefined) {
    const synced = await client().sync(id);
    out(formatSynced(synced), synced);
    return 0;
  }
  const result = await client().sync(id, target);
  out(result.target, result);
  if (!result.attached) console.error("It already syncs there.");
  return 0;
}

/** `vibe sources`: the vibe's sync entries, and adding or removing one. */
export async function sources(session: SyncSession, args: string[]): Promise<number> {
  const { client, flags, out, url } = session;
  const [verb, key] = args;
  switch (verb) {
    case undefined:
    case "list": {
      const list = await client().sources();
      out(
        list.length > 0
          ? list.map((source) => formatSource(source, url)).join("\n\n")
          : "This vibe syncs with nothing. `vibe sources create` adds a sync entry.",
        { sources: list },
      );
      return 0;
    }
    case "create": {
      const [service, ...others] = flags.service ?? [];
      if (!key || !flags.platform || !service) throw new UsageError(SOURCES_USAGE);
      if (others.length > 0) throw new UsageError("A sync entry acts as one service.");
      const source = await client().createSource({
        key,
        platform: platform(flags.platform),
        service,
        map: mappings(flags.map ?? [], flags.replies === true),
        credentials: await credentials(flags.credentials, true),
        api: flags.api,
      });
      out(
        [
          formatSource(source, url),
          "",
          "Point the platform's webhooks at the URL above, signed with the secret you gave.",
        ].join("\n"),
        { source },
      );
      return 0;
    }
    case "credentials": {
      if (!key) throw new UsageError(SOURCES_USAGE);
      const source = await client().updateSourceCredentials(
        key,
        await credentials(flags.credentials, false),
      );
      out(`updated the credentials of ${source.key}`, { source });
      return 0;
    }
    case "delete":
    case "rm": {
      if (!key) throw new UsageError(SOURCES_USAGE);
      const source = await client().deleteSource(key);
      out(`deleted ${source.key}`, { source });
      return 0;
    }
    default:
      throw new UsageError(`Unknown sources command "${verb}".\n${SOURCES_USAGE}`);
  }
}

/** `vibe inbox <key>`: the raw events a sync entry received, newest first. */
export async function inbox({ client, flags, out }: SyncSession, args: string[]): Promise<number> {
  const [key] = args;
  if (!key) throw new UsageError("Usage: vibe inbox <key> [-n <N>]");
  const limit = flags.limit === undefined ? undefined : integer(flags.limit, "--limit");
  const events = await client().inbox(key, { limit });
  out(
    events.length > 0
      ? events.map(formatReceived).join("\n")
      : `${key} has received nothing. Check that the platform's webhooks point at this entry.`,
    { events },
  );
  return 0;
}

function platform(named: string): SyncPlatform {
  if (named === "slack" || named === "github" || named === "linear") return named;
  throw new UsageError(`--platform is slack, github or linear, not "${named}".`);
}

/**
 * Reads `--map` arguments: `#errors=errors-www`, `acme/www=dev`, `ENG=dev`,
 * and for a repository whose pull requests and issues go to channels of their
 * own, `acme/api:pulls=prs` and `acme/api:issues=issues`.
 */
export function mappings(
  inputs: readonly string[],
  replies: boolean,
): Record<string, SyncMapInput> {
  const map: Record<string, Exclude<SyncMapInput, string>> = {};
  for (const input of inputs) {
    const equals = input.lastIndexOf("=");
    if (equals < 1 || equals === input.length - 1) {
      throw new UsageError(`--map takes PLATFORM-CHANNEL=CHANNEL, not "${input}".`);
    }
    const named = input.slice(0, equals);
    const channel = input.slice(equals + 1);
    const kind = /:(pulls|issues)$/.exec(named)?.[1] as "pulls" | "issues" | undefined;
    const from = kind === undefined ? named : named.slice(0, -kind.length - 1);
    const entry = map[from] ?? {};
    map[from] = { ...entry, [kind ?? "channel"]: channel, ...(replies ? { replies: true } : {}) };
  }
  // The plain form for a platform channel that maps to one channel and nothing more.
  return Object.fromEntries(
    Object.entries(map).map(([from, entry]) => [
      from,
      Object.keys(entry).length === 1 && entry.channel !== undefined ? entry.channel : entry,
    ]),
  );
}

/**
 * A sync entry's credentials, from a file or from the environment: never from
 * the command line, which is kept.
 *
 * @param whole Whether the secret must be there, as it must for a new entry.
 */
async function credentials<Whole extends boolean>(
  path: string | undefined,
  whole: Whole,
): Promise<
  Whole extends true ? { token?: string; secret: string } : { token?: string; secret?: string }
> {
  let given: { token?: unknown; secret?: unknown } = {
    token: process.env["VIBE_SYNC_TOKEN"],
    secret: process.env["VIBE_SYNC_SECRET"],
  };
  if (path !== undefined) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new UsageError(`There is no file at ${path}.`);
    try {
      given = (await file.json()) as typeof given;
    } catch {
      throw new UsageError(`${path} is not JSON. It holds { "token": "…", "secret": "…" }.`);
    }
  }
  const token = typeof given.token === "string" && given.token !== "" ? given.token : undefined;
  const secret = typeof given.secret === "string" && given.secret !== "" ? given.secret : undefined;
  if (secret === undefined && (whole || token === undefined)) {
    throw new UsageError(
      whole
        ? "A sync entry needs the secret its platform signs webhooks with. Set VIBE_SYNC_SECRET, or pass --credentials <FILE>."
        : "Give a new token, a new secret, or both: set VIBE_SYNC_TOKEN or VIBE_SYNC_SECRET, or pass --credentials <FILE>.",
    );
  }
  const out: { token?: string; secret?: string } = {};
  if (token !== undefined) out.token = token;
  if (secret !== undefined) out.secret = secret;
  return out as Whole extends true ? { token?: string; secret: string } : typeof out;
}

export function formatSource(source: SyncSource, url?: string | undefined): string {
  const state = source.state === "stopped" ? `stopped: ${source.reason ?? "unknown"}` : "active";
  const going = [
    state,
    ...(source.pending > 0 ? [`${source.pending} on the way out`] : []),
    ...(source.failed > 0 ? [`${source.failed} not delivered`] : []),
  ];
  const width = Math.max(...source.mappings.map((mapping) => mapping.platform.length), 1);
  const mapped = source.mappings.map((mapping) => {
    const which = mapping.only === null ? "" : ` (${mapping.only})`;
    const arrow = mapping.out ? "<->" : " ->";
    return `  ${mapping.platform.padEnd(width)}  ${arrow}  #${mapping.channel}${which}`;
  });
  return [
    `${source.key}  ${source.platform}  via ${source.service.handle}  ·  ${going.join("  ·  ")}`,
    ...(mapped.length > 0 ? mapped : ["  maps no channels: threads sync with it one at a time"]),
    `  webhooks: ${(url ?? "").replace(/\/+$/, "")}${source.webhook}`,
    `  sends to: ${source.api}`,
  ].join("\n");
}

export function formatSynced(synced: SyncedView): string {
  if (synced.targets.length === 0) return "This thread is on the vibe only.";
  const targets = synced.targets.map((target) => {
    const link = target.copy ?? target.url;
    return `${target.target}  ${target.state}${link === null ? "" : `  ${link}`}`;
  });
  const failures = synced.failures.map(
    (failure) =>
      `not delivered: ${failure.message} to ${failure.target}, ${ago(failure.at)}: ${failure.error ?? "unknown"}`,
  );
  return [...targets, ...failures].join("\n");
}

function formatReceived(entry: SyncInboxEntry): string {
  const note = entry.note === null ? "" : `  ${entry.note}`;
  return `${entry.receivedAt}  ${entry.event.padEnd(28)}  ${entry.state}${note}  ${entry.id}`;
}
