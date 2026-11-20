import type { VibeHandle, Watcher } from "@vibe/sdk";

import { ago } from "./format.ts";
import { UsageError } from "./shared.ts";

export interface WatcherSession {
  flags: {
    by?: string | undefined;
    mentions?: string | undefined;
    re?: string | undefined;
    source?: string | undefined;
    label?: string[] | undefined;
    all?: boolean | undefined;
    json?: boolean | undefined;
  };
  client(): VibeHandle;
  out(human: string, data: unknown): void;
}

const USAGE = `Usage: vibe watchers                               List the vibe's watchers
       vibe watchers create <name> <url> [channel] [--label <k[=v|w]>]... [--by <HANDLE>]
                            [--mentions[=HANDLE]] [--re <ID>] [--all]
                                                   Post each matching event to a URL
       vibe watchers delete <name|id>              Stop posting to it`;

/** `vibe watchers`: URLs that the vibe's matching events are posted to. */
export async function watchers(session: WatcherSession, args: string[]): Promise<number> {
  const { flags, out } = session;
  const [verb, name, url, channel] = args;
  const handle = session.client();

  switch (verb) {
    case undefined:
    case "list": {
      const list = await handle.watchers();
      out(
        list.length > 0
          ? list.map(formatWatcher).join("\n\n")
          : "No watchers yet. `vibe watchers create <name> <url> [channel]` adds one.",
        { watchers: list },
      );
      return 0;
    }
    case "create": {
      if (!name || !url) throw new UsageError(USAGE);
      const made = await handle.createWatcher({
        name,
        url,
        channel,
        by: flags.by,
        mentions: flags.mentions,
        source: flags.source,
        re: flags.re,
        label: flags.label,
        all: flags.all,
      });
      // Just the secret on stdout, so a script can keep it: secret=$(vibe watchers create …)
      out(made.secret, made);
      if (!flags.json) {
        console.error(
          [
            `Watching ${tailOf(made.watcher)} as ${made.watcher.name} (${made.watcher.id}).`,
            "Each delivery is signed with this secret, shown this once. Check Vibe-Signature with it.",
          ].join("\n"),
        );
      }
      return 0;
    }
    case "delete":
    case "rm": {
      if (!name) throw new UsageError(USAGE);
      const watcher = await handle.deleteWatcher(name);
      out(`deleted ${watcher.name}`, { watcher });
      return 0;
    }
    default:
      throw new UsageError(`Unknown watchers command "${verb}".\n${USAGE}`);
  }
}

/** What a watcher follows, as the `vibe tail` that would print the same events. */
function tailOf(watcher: Watcher): string {
  const { tail } = watcher;
  return [
    tail.channel,
    ...tail.labels.map((label) => `--label '${label}'`),
    ...(tail.by === null ? [] : [`--by ${tail.by}`]),
    ...(tail.mentions === null ? [] : [`--mentions=${tail.mentions}`]),
    ...(tail.re === null ? [] : [`--re ${tail.re}`]),
    ...(tail.all ? ["--all"] : []),
  ].join(" ");
}

function formatWatcher(watcher: Watcher): string {
  const going =
    watcher.state === "stopped"
      ? `stopped: ${watcher.reason ?? "unknown"}`
      : watcher.state === "failing"
        ? `failing after ${watcher.attempts} attempt(s): ${watcher.lastError ?? "unknown"}. Next try ${watcher.retryAt ?? "soon"}`
        : watcher.deliveredAt === null
          ? "nothing delivered yet"
          : `last delivered ${ago(watcher.deliveredAt)}`;
  return [
    `${watcher.name}  ${watcher.id}  ${watcher.url}`,
    `  tail ${tailOf(watcher)}`,
    `  registered by ${watcher.by.handle}  ·  ${going}`,
  ].join("\n");
}
