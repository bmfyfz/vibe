import { basename } from "node:path";

import {
  parseDuration,
  type TaskClaim,
  type TaskDetail,
  type TaskInput,
  type TaskState,
  VibeError,
  type VibeHandle,
} from "@vibe/sdk";

import { dropClaim, loadClaim, saveClaim } from "./claims.ts";
import { formatTask } from "./format.ts";
import { integer, readText, UsageError } from "./shared.ts";

export interface TaskFlags {
  json?: boolean | undefined;
  as?: string | undefined;
  state?: string | undefined;
  by?: string | undefined;
  for?: string | undefined;
  label?: string[] | undefined;
  limit?: string | undefined;
  file?: string | undefined;
  attach?: string[] | undefined;
  needs?: string[] | undefined;
  "idempotency-key"?: string | undefined;
  ready?: string | undefined;
  from?: string[] | undefined;
  wait?: string | undefined;
  lease?: string | undefined;
  result?: string | undefined;
  kind?: string | undefined;
  pool?: boolean | undefined;
  none?: boolean | undefined;
}

export interface TaskSession {
  flags: TaskFlags;
  client(): VibeHandle;
  out(human: string, data: unknown): void;
  /** What followed `--` on the command line: the command `tasks run` runs. */
  command: string[];
}

const USAGE = `Usage: vibe tasks [channel]                      List open tasks, oldest first
       vibe tasks create <channel> "<text>"       Start a thread as a task
       vibe tasks create <id>                     Make a task of an existing thread
       vibe tasks create <channel> --file <PATH>  Create a plan of tasks from a JSON file, or - for stdin
       vibe tasks claim <id> | --ready <channel>  Claim a task for a lease
       vibe tasks run <id> | --ready <channel> -- <cmd>
       vibe tasks renew|release <id>
       vibe tasks complete <id> ["<result>"]
       vibe tasks fail|block|cancel <id> "<reason>"
       vibe tasks unblock|reopen <id>
       vibe tasks assign <id> <profile> | --pool
       vibe tasks needs <id> <id>... | --none`;

const ACTIONS = new Set([
  "create",
  "claim",
  "run",
  "renew",
  "release",
  "complete",
  "fail",
  "block",
  "unblock",
  "reopen",
  "assign",
  "needs",
  "cancel",
]);

export async function tasks(session: TaskSession, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === undefined || !ACTIONS.has(action)) return list(session, action);

  switch (action) {
    case "create":
      return create(session, rest);
    case "claim":
      return claim(session, rest);
    case "run":
      return run(session, rest);
    case "assign":
      return assign(session, rest);
    case "needs":
      return needs(session, rest);
    default:
      return settle(session, action, rest);
  }
}

async function list({ client, flags, out }: TaskSession, channel?: string): Promise<number> {
  const found = await client().tasks.list({
    channel,
    state: flags.state as TaskState | "open" | "all" | undefined,
    by: flags.by,
    for: flags.for,
    label: flags.label,
    limit: flags.limit === undefined ? undefined : integer(flags.limit, "--limit"),
  });
  out(found.length > 0 ? found.map(formatTask).join("\n\n") : "No tasks here.", { tasks: found });
  return 0;
}

async function create(session: TaskSession, args: string[]): Promise<number> {
  const { client, flags, out } = session;
  const [target, ...words] = args;
  if (!target) throw new UsageError(USAGE);
  const handle = client();

  if (target.startsWith("msg_")) {
    const adopted = await handle.tasks.adopt(target, { needs: flags.needs, for: flags.for });
    out(adopted.task.id, adopted);
    return 0;
  }

  if (flags.file !== undefined) {
    const plan = parsePlan(await readText(flags.file, ""));
    const created = await handle.tasks.createPlan(target, plan, {
      idempotencyKey: flags["idempotency-key"],
    });
    out(created.map((detail) => detail.task.id).join("\n"), { tasks: created });
    return 0;
  }

  const attachments: string[] = [];
  for (const path of flags.attach ?? []) {
    const file = Bun.file(path);
    if (!(await file.exists())) throw new UsageError(`There is no file at ${path}.`);
    const uploaded = await handle.upload({
      name: basename(path),
      data: await file.arrayBuffer(),
      type: file.type || undefined,
    });
    attachments.push(uploaded.id);
  }
  const created = await handle.tasks.create(
    target,
    {
      text: await readText(undefined, words.join(" ")),
      labels: labelsOf(flags.label),
      needs: flags.needs,
      for: flags.for,
      attachments: attachments.length > 0 ? attachments : undefined,
    },
    { idempotencyKey: flags["idempotency-key"] },
  );
  // Just the ID, so a script can chain: id=$(vibe tasks create work "…")
  out(created.task.id, created);
  return 0;
}

/** Claims by ID, or the next ready task of a channel. Fails with a reason when there is none. */
async function take(session: TaskSession, id: string | undefined): Promise<TaskClaim> {
  const { client, flags } = session;
  const lease = flags.lease === undefined ? undefined : parseDuration(flags.lease) / 1000;
  if (id !== undefined && flags.ready !== undefined) {
    throw new UsageError("Pass a task's ID, or --ready <channel>, not both.");
  }
  if (id === undefined && flags.ready === undefined) throw new UsageError(USAGE);

  const claimed =
    id !== undefined
      ? await client().tasks.claim(id, { lease })
      : await client().tasks.claim(
          { channel: flags.ready, label: flags.label, from: flags.from, wait: flags.wait },
          { lease },
        );
  if (!claimed) {
    const left = await whatIsLeft(session).catch(() => undefined);
    throw flags.wait === undefined
      ? new VibeError("nothing_ready", "No task is ready to claim here.", 0, left)
      : new VibeError("timeout", `No task became ready in ${flags.wait}.`, 0, left);
  }
  await saveClaim(flags.as ?? process.env["VIBE_PROFILE"] ?? null, claimed.task.id, {
    claim: claimed.claim.id,
    expiresAt: claimed.claim.expiresAt,
  });
  return claimed;
}

async function claim(session: TaskSession, args: string[]): Promise<number> {
  const claimed = await take(session, args[0]);
  const { task, message, claim } = claimed;
  session.out(
    `${formatTask(claimed)}\n\nYours until ${claim.expiresAt}. Keep it with:\n  vibe tasks renew ${task.id}`,
    { task, message, claim },
  );
  return 0;
}

/** The claim this machine holds on a task, as the profile the command runs as. */
async function held(session: TaskSession, id: string): Promise<string> {
  const profile = session.flags.as ?? process.env["VIBE_PROFILE"] ?? null;
  const stored = await loadClaim(profile, id);
  if (stored) return stored;
  throw new VibeError(
    "claim_not_held",
    `You hold no claim on ${id} as ${profile ?? "yourself"}.`,
    0,
    "Run the command as the profile that claimed the task, with --as.",
  );
}

async function settle(session: TaskSession, action: string, args: string[]): Promise<number> {
  const { client, flags, out } = session;
  const [id, ...words] = args;
  if (!id) throw new UsageError(USAGE);
  const text = words.join(" ");
  const api = client().tasks;
  const profile = flags.as ?? process.env["VIBE_PROFILE"] ?? null;
  const need = (what: string) => {
    if (text === "") throw new UsageError(`Usage: vibe tasks ${action} <id> "<${what}>"`);
    return text;
  };

  let after: TaskDetail;
  switch (action) {
    case "renew": {
      const lease = flags.lease === undefined ? undefined : parseDuration(flags.lease) / 1000;
      const claimId = await held(session, id);
      const expiresAt = await api.renew(id, claimId, lease);
      await saveClaim(profile, id, { claim: claimId, expiresAt });
      out(`Yours until ${expiresAt}.`, { id, leaseExpiresAt: expiresAt });
      return 0;
    }
    case "release":
      after = await api.release(id, await held(session, id));
      break;
    case "complete":
      after = await api.complete(id, await held(session, id), text || undefined);
      break;
    case "fail":
      after = await api.fail(id, await held(session, id), need("reason"));
      break;
    case "block": {
      // A worker blocks with its claim. The task's owner needs none.
      const claimId = await loadClaim(profile, id);
      after = await api.block(id, need("reason"), {
        claim: claimId ?? undefined,
        kind: flags.kind,
      });
      break;
    }
    case "unblock":
      after = await api.unblock(id);
      break;
    case "reopen":
      after = await api.reopen(id);
      break;
    case "cancel":
      after = await api.cancel(id, need("reason"));
      break;
    default:
      throw new UsageError(USAGE);
  }
  // Whatever happened, a claim on this task is over.
  await dropClaim(profile, id);
  out(`${action} ${id}: now ${after.task.state}`, after);
  return 0;
}

async function assign({ client, flags, out }: TaskSession, args: string[]): Promise<number> {
  const [id, profile] = args;
  if (!id || (profile === undefined) === (flags.pool !== true)) {
    throw new UsageError("Usage: vibe tasks assign <id> <profile> | --pool");
  }
  const after = await client().tasks.assign(id, profile ?? null);
  out(
    after.task.for === null
      ? `${id} is for anyone who can claim it.`
      : `${id} is kept for ${after.task.for}.`,
    after,
  );
  return 0;
}

async function needs({ client, flags, out }: TaskSession, args: string[]): Promise<number> {
  const [id, ...others] = args;
  if (!id || (others.length === 0) === (flags.none !== true)) {
    throw new UsageError("Usage: vibe tasks needs <id> <id>... | --none");
  }
  const after = await client().tasks.needs(id, others);
  out(
    after.task.needs.length === 0
      ? `${id} waits for nothing: now ${after.task.state}`
      : `${id} waits for ${after.task.needs.join(", ")}: now ${after.task.state}`,
    after,
  );
  return 0;
}

/**
 * Claims a task, runs a command as its work, and settles the task by how the
 * command exits: 0 completes it, anything else fails it. The claim is renewed
 * while the command runs, and released if this process is told to stop.
 *
 * The command runs only while this process knows it holds the task. When the
 * lease it last had confirmed runs out, because the vibe said the claim is
 * lost or because it could not be reached to renew it, the command is
 * stopped: by then another worker may have the task.
 */
async function run(session: TaskSession, args: string[]): Promise<number> {
  const { flags, command } = session;
  if (command.length === 0)
    throw new UsageError("Usage: vibe tasks run <id> | --ready <channel> -- <cmd>");
  const claimed = await take(session, args[0]);
  const { id } = claimed.task;
  const profile = flags.as ?? process.env["VIBE_PROFILE"] ?? null;
  const lease = flags.lease === undefined ? 300 : parseDuration(flags.lease) / 1000;

  const child = Bun.spawn(command, {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, VIBE_TASK: id },
  });

  let lost: string | null = null;
  const giveUp = (why: string) => {
    lost ??= why;
    child.kill();
  };
  // The end of the lease as it was last confirmed. It is taken from the
  // vibe's clock and from this one, whichever comes first: a lease starts no
  // sooner than it was asked for, so counting from the asking is never late.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const heldUntil = (expiresAt: string, askedAt: number) => {
    const until = Math.min(Date.parse(expiresAt), askedAt + lease * 1000);
    clearTimeout(deadline);
    deadline = setTimeout(
      () => giveUp(`the lease on ${id} ran out before it could be renewed`),
      Math.max(0, until - Date.now()),
    );
  };
  heldUntil(claimed.claim.expiresAt, Date.now());
  const renewing = setInterval(
    () => {
      const askedAt = Date.now();
      claimed.renew(lease).then(
        (expiresAt) => heldUntil(expiresAt, askedAt),
        (error: unknown) => {
          // Someone else may hold the task now. Stop working on it.
          if (error instanceof VibeError && error.code === "claim_lost") {
            giveUp(`the claim on ${id} is over`);
          }
          // Any other failure leaves the deadline where it was: the lease
          // was not extended, so the command stops when it runs out.
        },
      );
    },
    (lease * 1000) / 3,
  );

  let stopped: number | null = null;
  const stop = (exitCode: number) => () => {
    stopped = exitCode;
    child.kill();
  };
  process.removeAllListeners("SIGINT");
  process.on("SIGINT", stop(130));
  process.on("SIGTERM", stop(143));

  const exitCode = await child.exited;
  clearInterval(renewing);
  clearTimeout(deadline);
  await dropClaim(profile, id);

  if (lost !== null) {
    console.error(`claim_lost: ${lost}, so the command was stopped.`);
    return 1;
  }
  if (stopped !== null) {
    await claimed.release().catch(() => {});
    return stopped;
  }
  if (exitCode === 0) await claimed.complete(flags.result);
  else await claimed.fail(`The command exited with code ${exitCode}.`);
  return exitCode;
}

/**
 * What stands between a worker that found nothing ready and the end of its
 * queue: whether the tasks it asked for are all finished, or some are still
 * held by others or waiting, and so may yet come its way.
 */
async function whatIsLeft({ client, flags }: TaskSession): Promise<string> {
  const open = await client().tasks.list({
    channel: flags.ready,
    label: flags.label,
    state: "open",
    limit: 200,
  });
  if (open.length === 0) return "Nothing is left here: every matching task is finished.";
  const count = (state: string) => open.filter((each) => each.task.state === state).length;
  const parts = [
    [count("claimed"), "claimed by someone"],
    [count("waiting"), "waiting for other tasks"],
    [count("blocked"), "held for a person"],
    [count("ready"), "ready, but not yours to take: kept for another profile or owner"],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, what]) => `${n} ${what}`);
  return `${open.length} still open here: ${parts.join(", ")}. One may yet come your way.`;
}

function labelsOf(pairs: string[] | undefined): Record<string, string> | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;
  const labels: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf("=");
    if (equals < 1) throw new UsageError(`--label takes k=v, not "${pair}".`);
    labels[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return labels;
}

function parsePlan(text: string): TaskInput[] {
  let plan: unknown;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new UsageError("A plan is a JSON array of tasks.");
  }
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new UsageError("A plan is a JSON array of at least one task.");
  }
  return plan as TaskInput[];
}
