import type {
  Actor,
  Attachment,
  Explanation,
  Grant,
  Message,
  Schedule,
  Task,
  TaskDetail,
  ThreadDetail,
  ThreadSummary,
  VibeEvent,
} from "@vibe/sdk";

/** How long ago something happened, in the largest unit that fits. */
export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** How an actor is shown: a person by their handle, a profile with who is behind it. */
export function who(actor: Actor): string {
  if (actor.profile === null) return actor.handle;
  return `${actor.name} via ${actor.handle.split("/")[0] ?? actor.handle}`;
}

export function formatActor(actor: Actor): string {
  return `${actor.handle.padEnd(24)}  ${actor.actor}${actor.profile === null ? "" : `  (${who(actor)})`}`;
}

function permissions(list: readonly string[]): string {
  return list.length > 0 ? list.join(", ") : "none";
}

/** What someone can do at each pattern, the pattern that decides last first. */
export function formatCan(can: Readonly<Record<string, readonly string[]>>): string {
  const width = Math.max(...Object.keys(can).map((pattern) => pattern.length), 1);
  return Object.entries(can)
    .map(([pattern, list]) => `  ${pattern.padEnd(width)}  ${permissions(list)}`)
    .join("\n");
}

export function formatGrant(grant: Grant): string {
  const names = grant.principals.map((principal) => {
    if (principal.kind === "user") return principal.handle;
    return principal.kind === "service" ? `${principal.name} (service)` : principal.kind;
  });
  return `${grant.id}  ${names.join(", ")}\n${formatCan(grant.can)}`;
}

export function formatExplanation(explained: Explanation): string {
  const { principal, channel, role } = explained;
  if (explained.pattern === null) {
    return `No grant reaches ${principal.handle} in ${channel}, so they can do nothing there.`;
  }
  const decided = `${explained.grants.join(" and ")} at ${explained.pattern}`;
  const capped =
    explained.can.length < explained.granted.length
      ? `\nIt gives ${permissions(explained.granted)}; the ${role} role allows only that much.`
      : "";
  const what = explained.can.length > 0 ? explained.can.join(", ") : "do nothing";
  return `${principal.handle} can ${what} in ${channel}.\nDecided by ${decided}.${capped}`;
}

export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((line) => `${by}${line}`)
    .join("\n");
}

function files(attachments: readonly Attachment[]): string[] {
  return attachments.map((file) => `  [file] ${file.name} (${bytes(file.size)}) ${file.id}`);
}

/** A message's structured data, a line a block. */
function data(message: Message): string[] {
  return message.blocks.map(
    (block) => `  [data] ${block.schema}@${block.version} ${JSON.stringify(block.data)}`,
  );
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function labels(message: Message): string {
  const pairs = Object.entries(message.labels).map(([key, value]) => `${key}=${value}`);
  return pairs.length > 0 ? `  [${pairs.join(" ")}]` : "";
}

function reactions(message: Message): string[] {
  if (message.reactions.length === 0) return [];
  const each = message.reactions.map(
    (reaction) => `:${reaction.emoji}: ${reaction.by.map((actor) => actor.handle).join(", ")}`,
  );
  return [`  ${each.join("   ")}`];
}

/** A message's text as people read it: each stored `@[actor-id]` shown as that actor's handle. */
export function readable(message: Message): string {
  let text = message.text;
  for (const mention of message.mentions) {
    text = text.replaceAll(`@[${mention.actor}]`, `@${mention.handle}`);
  }
  return text;
}

export function formatMessage(message: Message): string {
  const edited = message.deletedAt === null && message.revision > 1 ? "  (edited)" : "";
  // Where it was written, when that wasn't here, and whether it stays here.
  const from = message.from === "vibe" ? "" : `  from ${message.from}`;
  const kept = message.noSync ? "  (no sync)" : "";
  const head = `${message.id}  ${who(message.by)}${from}  ${ago(message.createdAt)}${edited}${kept}${labels(message)}`;
  if (message.deletedAt !== null) return `${head}\n  (deleted ${ago(message.deletedAt)})`;
  const body = message.text === "" ? [] : [indent(readable(message))];
  return [
    head,
    ...body,
    ...data(message),
    ...files(message.attachments),
    ...reactions(message),
  ].join("\n");
}

export function formatSummary(thread: ThreadSummary): string {
  const { message, replies, last } = thread;
  const lines = [`#${message.channel}  ${formatMessage(message)}`];
  if (last) {
    const count = replies === 1 ? "1 reply" : `${replies} replies`;
    lines.push(
      `  -> ${count}, latest from ${who(last.by)} ${ago(last.createdAt)}: ${last.deletedAt === null ? oneLine(readable(last)) : "(deleted)"}`,
    );
  }
  return lines.join("\n");
}

/** Where a task stands, in a line. */
export function taskLine(task: Task): string {
  const parts = [`task: ${task.state}`, `owned by ${who(task.owner)}`];
  if (task.for !== null) parts.push(`kept for ${task.for}`);
  if (task.claimedBy !== null) {
    parts.push(`held by ${who(task.claimedBy)} until ${task.leaseExpiresAt ?? "?"}`);
  }
  // Only while it waits. Once a task is ready its needs are met, and saying
  // "waits for" beside a claimed or completed task reads as if they weren't.
  if (task.needs.length > 0 && task.state === "waiting") {
    parts.push(`waits for ${task.needs.join(", ")}`);
  }
  if (task.hold !== null) parts.push(`held for a person (${task.hold.kind}): ${task.hold.reason}`);
  if (task.result !== null) parts.push(`result: ${task.result}`);
  if (task.reason !== null) parts.push(`reason: ${task.reason}`);
  return parts.join("  ·  ");
}

export function formatTask(detail: TaskDetail): string {
  return `#${detail.task.channel}  ${formatMessage(detail.message)}\n  ${taskLine(detail.task)}`;
}

export function formatThread(thread: ThreadDetail): string {
  // A delivery that failed shows under its message, until a later one to the same place goes through.
  const undelivered = (message: Message) =>
    (thread.sync?.failures ?? [])
      .filter((failure) => failure.message === message.id)
      .map((failure) => `  ! not delivered to ${failure.target}: ${failure.error ?? "unknown"}`);
  const shown = (message: Message) => [formatMessage(message), ...undelivered(message)].join("\n");

  const synced = (thread.sync?.targets ?? []).map((target) => target.target);
  const where = synced.length > 0 ? [`  synced with ${synced.join(", ")}`] : [];
  const task = thread.task === null ? [] : [`  ${taskLine(thread.task)}`];
  const blocks = [
    [`#${thread.message.channel}  ${shown(thread.message)}`, ...task, ...where].join("\n"),
  ];
  for (const reply of thread.replies) blocks.push(indent(shown(reply)));
  for (const schedule of thread.schedules) blocks.push(indent(formatSchedule(schedule)));
  return blocks.join("\n\n");
}

/**
 * What a task's event says happened to it, and who did it. A wait or a tail
 * shows the task's message as it stands, which reads the same before and after
 * a claim, so this line is the only place the change itself is said.
 */
function taskChange(event: VibeEvent): string {
  const by = who(event.actor);
  const { payload } = event;
  const said = (key: string) => {
    const value = payload[key];
    return typeof value === "string" && value !== "" ? `: ${oneLine(value)}` : "";
  };
  const until = `until ${String(payload["leaseExpiresAt"] ?? "?")}`;
  const needs = Array.isArray(payload["needs"]) ? payload["needs"].map(String) : [];
  switch (event.type) {
    case "task.created":
      return `${by} made it a task${needs.length > 0 ? `, waiting for ${needs.join(", ")}` : ""}`;
    case "task.ready":
      return "ready to claim: nothing it waited for is left";
    case "task.claimed":
      return `${by} claimed it ${until}`;
    case "task.renewed":
      return `${by} renewed the claim ${until}`;
    case "task.released":
      return `${by} released it`;
    case "task.expired":
      return `${by} lost it: the lease ran out`;
    case "task.completed":
      return `${by} completed it${said("result")}`;
    case "task.failed":
      return `${by} failed it${said("reason")}`;
    case "task.blocked":
      return `${by} held it for a person (${String(payload["kind"] ?? "blocked")})${said("reason")}`;
    case "task.unblocked":
      return `${by} lifted the hold`;
    case "task.reopened":
      return `${by} made it ready again`;
    case "task.canceled":
      return `${by} canceled it${said("reason")}`;
    case "task.assigned":
      return typeof payload["for"] === "string"
        ? `${by} kept it for ${payload["for"]}`
        : `${by} opened it to any profile`;
    case "task.needs_changed":
      return needs.length > 0
        ? `${by} has it wait for ${needs.join(", ")}`
        : `${by} has it wait for nothing`;
    default:
      return `${by} changed it`;
  }
}

/** A span of seconds in the largest unit that divides it, such as `1d` or `90m`. */
export function span(seconds: number): string {
  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
  ] as const) {
    if (seconds >= size && seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/** How far off a time is, in the largest unit that fits. */
function away(iso: string, now: number): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `in ${Math.floor(seconds / 3600)}h`;
  return `in ${Math.floor(seconds / 86_400)}d`;
}

/** A schedule: where and when it posts on its first line, then what. */
export function formatSchedule(schedule: Schedule, now: number = Date.now()): string {
  const where =
    schedule.re === null ? `#${schedule.channel}` : `#${schedule.channel} in ${schedule.re}`;
  const parts =
    schedule.nextAt === null
      ? [schedule.reason === null ? schedule.state : `${schedule.state}: ${schedule.reason}`]
      : [`posts ${schedule.nextAt} (${away(schedule.nextAt, now)})`];
  if (schedule.every !== null) parts.push(`every ${span(schedule.every)}`);
  if (schedule.remaining !== null) parts.push(`${schedule.remaining} left`);
  if (schedule.until !== null) parts.push(`until ${schedule.until}`);
  if (schedule.runs > 0) parts.push(`posted ${schedule.runs} so far`);
  const head = `${schedule.id}  ${where}  ${who(schedule.by)}  ${parts.join("  ·  ")}`;
  const carried = schedule.blocks.map(
    (block) => `  [data] ${block.schema} ${JSON.stringify(block.data)}`,
  );
  const body = schedule.text === "" ? [] : [indent(oneLine(schedule.text))];
  return [head, ...body, ...carried].join("\n");
}

export function formatEvent(event: VibeEvent): string {
  const time = new Date(event.createdAt).toISOString().slice(11, 19);
  const { message } = event;
  if (!message) return `${time}  ${event.type}  ${who(event.actor)}`;
  const where = message.re ? `#${message.channel} in ${message.re}` : `#${message.channel}`;
  const attached = message.attachments.length > 0 ? ` [${message.attachments.length} file(s)]` : "";
  const line = `${time}  ${event.type}  ${where}  ${message.id}`;
  if (event.type === "labels.changed") {
    return `${line}  ${who(event.actor)} changed labels:${labels(message) || " none left"}`;
  }
  if (event.type === "reaction.added" || event.type === "reaction.removed") {
    const verb = event.type === "reaction.added" ? "reacted with" : "took back";
    return `${line}  ${who(event.actor)} ${verb} :${String(event.payload["emoji"])}:`;
  }
  if (event.type === "message.deleted") return `${line}  ${who(event.actor)} deleted it`;
  if (event.type.startsWith("task.")) return `${line}  ${taskChange(event)}`;
  const carried = message.blocks.map((block) => ` [${block.schema}@${block.version}]`).join("");
  return `${line}  ${who(message.by)}: ${oneLine(readable(message))}${carried}${attached}`;
}
