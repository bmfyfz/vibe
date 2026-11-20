import type { ScheduleOptions, VibeHandle } from "@vibe/sdk";

import { formatSchedule } from "./format.ts";
import { blockFrom } from "./schemas.ts";
import { integer, readText, UsageError } from "./shared.ts";

export interface ScheduleFlags {
  in?: string | undefined;
  at?: string | undefined;
  every?: string | undefined;
  for?: string | undefined;
  times?: string | undefined;
  until?: string | undefined;
  file?: string | undefined;
  label?: string[] | undefined;
  schema?: string | undefined;
  by?: string | undefined;
  channel?: string | undefined;
  all?: boolean | undefined;
  json?: boolean | undefined;
  "no-sync"?: boolean | undefined;
}

export interface ScheduleSession {
  flags: ScheduleFlags;
  client(): VibeHandle;
  out(human: string, data: unknown): void;
}

const USAGE = `Usage: vibe schedule <channel|id> [text] (--in <DURATION> | --at <TIME> | --every <DURATION>)
                     [--for <DURATION>] [--times <N>] [--until <TIME>]
       vibe schedule cancel <schedule>
       vibe schedules [schedule|id] [--by <HANDLE>] [--channel <CHANNEL>] [--all]`;

/** `vibe schedule`: post later, once or at an interval, or call a schedule off. */
export async function schedule(
  session: ScheduleSession,
  args: string[],
  labels: (inputs: readonly string[]) => Record<string, string>,
): Promise<number> {
  const { flags, out } = session;
  const [target, ...words] = args;
  if (!target) throw new UsageError(USAGE);
  if (target === "cancel" && words[0]?.startsWith("sch_")) return cancel(session, words[0]);

  const text = await readText(flags.file, words.join(" "));
  const blocks = flags.schema === undefined ? undefined : [blockFrom(flags.schema, text)];
  const options: ScheduleOptions = {
    text: blocks ? "" : text,
    labels: flags.label ? labels(flags.label) : undefined,
    blocks,
    noSync: flags["no-sync"],
    in: flags.in,
    at: flags.at === undefined ? undefined : time(flags.at, "--at"),
    every: flags.every,
    for: flags.for,
    times: flags.times === undefined ? undefined : integer(flags.times, "--times"),
    until: flags.until === undefined ? undefined : time(flags.until, "--until"),
  };
  const made = await session
    .client()
    .schedule(target.startsWith("msg_") ? { re: target } : target, options);

  // Just the ID, so a script can chain: s=$(vibe schedule dev "…" --in 1d)
  out(made.id, { schedule: made });
  if (!flags.json) console.error(formatSchedule(made).split("\n")[0]);
  return 0;
}

async function cancel({ client, out }: ScheduleSession, id: string): Promise<number> {
  const result = await client().cancelSchedule(id);
  out(
    result.canceled ? `canceled ${id}` : `${id} had already ended: ${result.schedule.state}`,
    result,
  );
  return 0;
}

/** `vibe schedules`: the pending schedules, a thread's, or one. */
export async function schedules(session: ScheduleSession, args: string[]): Promise<number> {
  const { flags, out } = session;
  const [target] = args;
  const handle = session.client();
  if (target?.startsWith("sch_")) {
    const one = await handle.getSchedule(target);
    out(formatSchedule(one), { schedule: one });
    return 0;
  }
  if (target !== undefined && !target.startsWith("msg_")) throw new UsageError(USAGE);

  const list = await handle.schedules({
    re: target,
    by: flags.by,
    channel: flags.channel,
    all: flags.all,
  });
  out(
    list.length > 0
      ? list.map((each) => formatSchedule(each)).join("\n\n")
      : flags.all
        ? "No schedules."
        : "Nothing is scheduled. Add --all to see schedules that have ended.",
    { schedules: list },
  );
  return 0;
}

/** A time as the user wrote it, read in their own time zone unless it names one. */
function time(input: string, flag: string): string {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new UsageError(`${flag} takes a time, such as 2026-11-02T09:00:00Z, not "${input}".`);
  }
  return parsed.toISOString();
}
