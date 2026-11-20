#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  type CanInput,
  deviceLogin,
  failure,
  type Filters,
  type GrantPrincipalInput,
  type HeldToken,
  parseDuration,
  vibe,
  VibeError,
  type VibeHandle,
  type Written,
} from "@vibe/sdk";

import { type Config, configPath, loadConfig, saveConfig } from "./config.ts";
import { revokedLine, sessions, tokenLine, tokens } from "./credentials.ts";
import {
  bytes,
  formatActor,
  formatCan,
  formatEvent,
  formatExplanation,
  formatGrant,
  formatMessage,
  formatSummary,
  formatThread,
  who,
} from "./format.ts";
import { schedule, schedules } from "./schedules.ts";
import { blockFrom, schemas } from "./schemas.ts";
import { serve } from "./serve.ts";
import { services } from "./services.ts";
import { integer, readText, UsageError } from "./shared.ts";
import { inbox, sources, sync } from "./sync.ts";
import { tasks } from "./tasks.ts";
import { watchers } from "./watchers.ts";

const HELP = `vibe <command> [options]

Read and write your team's vibe: channels, threads and files, for people and coding agents.

Commands
  whoami                          Show who you are, which vibe you're using, and what you can do
  login <url>                     Sign in through GitHub in a browser, or with a token you were
                                  given (--token, VIBE_TOKEN, or stdin), and remember both
  channels                        List the channels you can read
  channels create <channel>       Create a channel before anything posts to it. --private closes
                                  it to everyone but you
  actors                          List people and agents, with their handles and actor IDs
  read [channel|id]               List a channel's latest threads, or read one thread in full
  post <channel|id> [text]        Start a thread in a channel, or reply when given a message ID
  reply <id> [text]               Reply in a thread
  edit <id> [text]                Change the text of a message you wrote
  delete <id>                     Delete a message you wrote, leaving a tombstone (also rm, del)
  react <id> <emoji>              React to a message. Add --remove to take it back
  label <id> [k=v]...             Set or remove labels on a message
  tasks [channel]                 List open tasks, oldest first
  tasks create <channel> [text]   Start a thread as a task, or with --file create a plan of them
  tasks claim <id>|--ready <chan> Claim a task for a lease
  tasks run <id>|--ready <chan> -- <cmd>
                                  Claim a task, run a command, and settle it by the exit code
  tasks complete|fail|release|renew|block|unblock|reopen|cancel <id>
  tasks assign <id> <profile>     Keep a task for one profile, or --pool to return it
  tasks needs <id> <id>...        Replace what a task waits for, or --none
  schedule <channel|id> [text]    Post later, once (--in, --at) or at an interval (--every)
  schedule cancel <schedule>      Call a schedule off
  schedules [schedule|id]         List pending schedules, a thread's schedules, or one schedule
  tail [channel]                  Print activity live until you press Ctrl-C
  wait [channel|id]               Block until the next matching event, then print it
  download <attachment-id> [path] Save an attachment. Pass - to write to stdout
  schemas                         List the team's schemas for structured data
  schemas inspect <name@version>  Print one schema
  schemas create <name@version>   Register a version of a schema from --file or --data
  grants                          List the vibe's grants: who can do what in which channels
  grants create                   Give --can to --user, --service, --all-users, --all-services
                                  or --everyone
  grants update <grant>           --add-user, --remove-user, --add-service, --remove-service, or
                                  replace what it gives with --can
  grants explain <channel>        Show which grant decides a channel for you, or for --user or
                                  --service
  grants revoke <grant>           Take back what a grant gave
  watchers                        List the vibe's watchers: URLs its events are posted to
  watchers create <name> <url> [channel]
                                  Post each matching event to a URL, signed. Takes the filters
                                  of tail: --label, --by, --mentions, --re, --all
  watchers delete <name|id>       Stop posting to a watcher
  sync <id> [target]              Show where a thread is synced, or sync it with a platform:
                                  slack:#incidents, github:acme/www:123, linear:ENG-45
  sources                         List the vibe's sync entries: Slack, GitHub and Linear accounts
                                  whose channels sync with its channels
  sources create <key>            Add a sync entry, as a team owner: --platform, --service, --map
  sources credentials <key>       Replace a sync entry's token, its webhook secret, or both
  sources delete <key>            Remove a sync entry
  inbox <key>                     Print the raw events a sync entry received, newest first
  token create                    Mint a short-lived token that writes as --as and can do no more
                                  than --can, to hand to an agent or a job
  tokens                          List the tokens you hold: what each is for, never its secret
  tokens revoke <token-id>        Revoke one of your tokens. Tokens minted with it, and browser
                                  sessions opened with it, stop working too
  sessions                        List the browsers you are signed in from
  sessions end <session-id>       Sign one of them out, from here
  services                        List the team's services: machine principals for CI and workers
  services create <name>          Add a service and print its token, as a team owner
  services token <name>           Mint another token for a service
  services tokens <name>          List a service's tokens
  services revoke <name> <token-id>
                                  Revoke one of a service's tokens
  services delete <name>          Remove a service and revoke its tokens
  admin user create <handle>      Add a person and print their token (needs --admin-secret)
  admin user link <handle>        Say which GitHub account a person signs in with (--github)
  admin user tokens <handle>      List a person's tokens
  admin user revoke <handle> <token-id>
                                  Revoke one of a person's tokens, such as one they lost
  serve                           Run a Vibe on this machine, kept in .vibe/ at the root of the Git
                                  checkout, and print the VIBE_URL and a token that reach it

Options
      --json                Print one JSON document for programs
      --url <URL>           Use the Vibe at this URL            (VIBE_URL)
      --name <VIBE>         Use the team's vibe with this name  (VIBE_NAME, default general)
      --token <TOKEN>       Act with this token                 (VIBE_TOKEN)
      --as <PROFILE>        Write as a profile, such as an agent's name  (VIBE_PROFILE)
      --by <HANDLE>         Only by this author: a handle, me, or an actor ID. A person's
                            handle covers their agents too: =ada is ada alone
      --mentions[=HANDLE]   Only mentioning you, or a handle or actor ID given after =
      --label <k[=v|w]>     On read, tail and wait: only with this label, on the message or its
                            thread's root. Repeat to require more. On post and reply: set k=v
      --unset <K>           With label: remove this label. Repeat for more
      --if <k=v>            With label: only while the message has this label. Repeat for more
      --if-unset <K>        With label: only while the message doesn't have this label
      --if-revision <N>     With edit and delete: only while the message is at this revision
      --remove              With react: take your reaction back
      --source <SOURCE>     Only from a source: a sync entry's key, such as slack, or vibe
      --re <ID>             Only in the thread whose root has this ID
      --after <ID>          After a message ID or a cursor. On reply: only while it's the newest
  -n, --limit <N>           How many threads to list (default 50)
      --file <PATH>         Read the text from a file. - reads stdin
      --attach <FILE>       Attach a file of up to 100 MB. Repeat for up to 10
      --schema <NAME@VER>   With post, reply and edit: send structured data. The text is JSON
                            that matches this schema, such as sandbox@1
      --data <JSON>         With schemas create: the JSON Schema, inline
      --description <TEXT>  With schemas create: what the schema is for
      --idempotency-key <K> Post once, even when you send the same key again
      --sync <TARGET>       With post, on a new thread: also start or join a thread on a synced
                            platform, such as slack:#incidents. Repeat for more
      --no-sync             With post, reply and schedule: keep the message off every synced
                            platform. On a thread's root, it keeps the whole thread off
      --platform <NAME>     With sources create: slack, github or linear
      --map <FROM=CHANNEL>  With sources create: a platform channel and the vibe channel it syncs
                            with, such as '#errors=errors-www', acme/www=dev, acme/api:pulls=prs
                            or ENG=dev. Repeat for more
      --replies             With sources create, for GitHub: send replies written on the vibe
                            back as comments. Off, since a repository is often public
      --api <URL>           With sources create: where the platform's API is, when it isn't the
                            usual place, such as a GitHub Enterprise Server
      --credentials <FILE>  With sources create: a JSON file with the platform's token and
                            webhook secret, in place of VIBE_SYNC_TOKEN and VIBE_SYNC_SECRET
      --private             With channels create: close the channel to everyone but you
      --user <HANDLE>       With grants: a person on your team. Repeat to name several
      --service <NAME>      With grants: a service on your team. Repeat to name several.
                            With sources create: the one service the entry acts as
      --all-users           With grants create: every person on your team
      --all-services        With grants create: every service on your team
      --everyone            With grants create: everyone that something else lets in
      --can <PATTERN=PERMS> With grants and token create: what to give at a channel, a subtree
                            such as www/, or *. PERMS is all, none, or a list of
                            read,post,react,label,sync,manage
      --ttl <DURATION>      With token create: how long the token lasts, such as 1h (the default).
                            At most 24h
      --add-user <HANDLE>   With grants update: name one more person
      --remove-user <HANDLE> With grants update: stop naming a person
      --add-service <NAME>  With grants update: name one more service
      --remove-service <NAME> With grants update: stop naming a service
      --in <DURATION>       With schedule: post once, this long from now, such as 1d
      --at <TIME>           With schedule: post once at this time, or with --every, start then
      --every <DURATION>    With schedule: repeat at this interval, such as 30m. The shortest is 1m
      --for <DURATION>      With schedule: repeat for this long, such as 24h
      --times <N>           With schedule: post this many times in all
  -u, --until <TIME>        With schedule: repeat until this time
      --channel <CHANNEL>   With schedules: only those that post in this channel, or under www/
      --timeout <DURATION>  How long wait blocks, such as 30s, 10m, 1h (default 30m)
      --state <STATE>       With tasks: one state, open (default), or all
      --for <PROFILE>       With tasks: kept for this profile of the owner
      --needs <ID>          With tasks create: wait for this task. Repeat for more
      --ready <CHANNEL>     With tasks claim and run: the oldest ready task there, or under www/
      --from <ACTOR-ID>     With --ready: also take tasks this actor owns. Repeat for more
      --wait <DURATION>     With --ready: wait this long for a task to become ready
      --lease <DURATION>    With tasks claim, run and renew: how long the lease lasts (up to 5m)
      --result <TEXT>       With tasks run: the result to complete the task with
      --kind <KIND>         With tasks block: what the hold is for, such as awaiting_approval
  -a, --all                 With tail: also print events that only keep the books. With
                            schedules: also list those that are done, canceled or stopped
      --role <ROLE>         With admin user create: owner, member or viewer
      --github <LOGIN>      With admin user create and link: the GitHub account they sign in with
      --save                With admin user create: log in as the new user
      --port <PORT>         With serve: the port to listen on (VIBE_PORT, default 7473)
      --host <ADDRESS>      With serve: the address to listen on (default 127.0.0.1, this machine)
      --dir <PATH>          With serve: where to keep the Vibe, instead of .vibe/. A new Vibe
                            belongs to you, or to the handle VIBE_OWNER names
      --web <PATH>          With serve: where the built web app is (VIBE_WEB_DIR). By default,
                            the one this checkout built with bun web:build
      --public-url <URL>    With serve, behind a proxy that ends TLS: the address people reach
                            it at, such as https://vibe.example.com (VIBE_PUBLIC_URL). Signing
                            in from a browser needs it there
      --address-header <H>  With serve, behind a proxy: the header the proxy puts the client's
                            address in, such as x-forwarded-for (VIBE_ADDRESS_HEADER). Sign-in
                            limits are counted against it, so name one only your proxy sets
  -h, --help                Show this help

Exit codes: 0 success, 1 failure or timeout, 2 usage error, 130 stopped with Ctrl-C.`;

const OPTIONS = {
  json: { type: "boolean" },
  url: { type: "string" },
  name: { type: "string" },
  token: { type: "string" },
  as: { type: "string" },
  by: { type: "string" },
  mentions: { type: "string" },
  label: { type: "string", multiple: true },
  unset: { type: "string", multiple: true },
  if: { type: "string", multiple: true },
  "if-unset": { type: "string", multiple: true },
  "if-revision": { type: "string" },
  remove: { type: "boolean" },
  private: { type: "boolean" },
  user: { type: "string", multiple: true },
  service: { type: "string", multiple: true },
  "all-users": { type: "boolean" },
  "all-services": { type: "boolean" },
  everyone: { type: "boolean" },
  can: { type: "string", multiple: true },
  ttl: { type: "string" },
  "add-user": { type: "string", multiple: true },
  "remove-user": { type: "string", multiple: true },
  "add-service": { type: "string", multiple: true },
  "remove-service": { type: "string", multiple: true },
  re: { type: "string" },
  source: { type: "string" },
  sync: { type: "string", multiple: true },
  "no-sync": { type: "boolean" },
  platform: { type: "string" },
  map: { type: "string", multiple: true },
  replies: { type: "boolean" },
  api: { type: "string" },
  credentials: { type: "string" },
  after: { type: "string" },
  limit: { type: "string", short: "n" },
  file: { type: "string" },
  attach: { type: "string", multiple: true },
  schema: { type: "string" },
  data: { type: "string" },
  description: { type: "string" },
  "idempotency-key": { type: "string" },
  in: { type: "string" },
  at: { type: "string" },
  every: { type: "string" },
  times: { type: "string" },
  until: { type: "string", short: "u" },
  channel: { type: "string" },
  timeout: { type: "string" },
  state: { type: "string" },
  for: { type: "string" },
  needs: { type: "string", multiple: true },
  ready: { type: "string" },
  from: { type: "string", multiple: true },
  wait: { type: "string" },
  lease: { type: "string" },
  result: { type: "string" },
  kind: { type: "string" },
  pool: { type: "boolean" },
  none: { type: "boolean" },
  all: { type: "boolean", short: "a" },
  "admin-secret": { type: "string" },
  role: { type: "string" },
  github: { type: "string" },
  save: { type: "boolean" },
  port: { type: "string" },
  host: { type: "string" },
  dir: { type: "string" },
  web: { type: "string" },
  "address-header": { type: "string" },
  "public-url": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Flags = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

interface Session {
  flags: Flags;
  config: Config;
  url: string | undefined;
  token: string | undefined;
  /** The handle on the vibe. Fails with a usage error when there is no URL to reach. */
  client(): VibeHandle;
  out(human: string, data: unknown): void;
  /** What followed `--` on the command line. */
  command: string[];
}

async function main(argv: string[]): Promise<number> {
  // Everything after `--` is a command for `tasks run`, not ours to parse.
  const dashes = argv.indexOf("--");
  const ours = dashes === -1 ? argv : argv.slice(0, dashes);
  const trailing = dashes === -1 ? [] : argv.slice(dashes + 1);
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    // --mentions takes an optional value, which parseArgs can't express: alone it means you.
    const args = ours.map((arg) => (arg === "--mentions" ? "--mentions=me" : arg));
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const flags = parsed.values;
  const [command, ...args] = parsed.positionals;
  if (flags.help || command === undefined || command === "help") {
    console.log(HELP);
    return 0;
  }

  const config = await loadConfig();
  const url = flags.url ?? process.env["VIBE_URL"] ?? config.url;
  // A saved token is the saved Vibe's, and goes nowhere else: with another
  // address on the command line or in the environment, it stays where it is.
  const saved = sameVibe(url, config.url) ? config.token : undefined;
  const token = flags.token ?? process.env["VIBE_TOKEN"] ?? saved;
  const session: Session = {
    flags,
    config,
    url,
    token,
    client() {
      if (!url)
        throw new UsageError(
          "There is no vibe to use. Pass --url, set VIBE_URL, or run `vibe login <url>`.",
        );
      if (token === undefined && config.token !== undefined && config.url !== undefined) {
        throw new UsageError(
          `Your saved login is for ${config.url}, and is not sent to ${url}. Pass --token or set VIBE_TOKEN for that Vibe, or run \`vibe login ${url}\`.`,
        );
      }
      return vibe({
        url,
        token,
        name: flags.name ?? process.env["VIBE_NAME"] ?? config.name,
        profile: flags.as ?? process.env["VIBE_PROFILE"] ?? null,
      });
    },
    out(human, data) {
      console.log(flags.json ? JSON.stringify(data) : human);
    },
    command: trailing,
  };

  switch (command) {
    case "whoami":
      return whoami(session);
    case "login":
      return login(session, args);
    case "channels":
      return channels(session, args);
    case "grants":
      return grants(session, args);
    case "services":
      return services(session, args);
    case "token":
    case "tokens":
      return args[0] === "create" ? mintToken(session, args) : tokens(session, args);
    case "sessions":
      return sessions(session, args);
    case "watchers":
      return watchers(session, args);
    case "sync":
      return sync(session, args);
    case "sources":
      return sources(session, args);
    case "inbox":
      return inbox(session, args);
    case "actors":
      return actors(session);
    case "read":
      return read(session, args);
    case "post":
      return post(session, args);
    case "reply":
      return post(session, args, true);
    case "edit":
      return edit(session, args);
    case "delete":
    case "rm":
    case "del":
      return remove(session, args);
    case "react":
      return react(session, args);
    case "label":
      return label(session, args);
    case "tasks":
      return tasks(session, args);
    case "schemas":
      return schemas(session, args);
    case "schedule":
      return schedule(session, args, (inputs) => pairs(inputs, "--label"));
    case "schedules":
      return schedules(session, args);
    case "tail":
      return tail(session, args);
    case "wait":
      return wait(session, args);
    case "download":
      return download(session, args);
    case "admin":
      return admin(session, args);
    case "serve":
      return serve(flags);
    default:
      throw new UsageError(`Unknown command "${command}". Run \`vibe help\`.`);
  }
}

async function whoami({ client, out, url }: Session): Promise<number> {
  const handle = client();
  const me = await handle.whoami();
  out(
    [
      me.role === "service"
        ? `You are ${who(me.actor)} (${me.actor.actor}), a service on team ${me.team.name}.`
        : `You are ${who(me.actor)} (${me.actor.actor}), ${me.role} on team ${me.team.name}.`,
      ...(me.actor.profile === null
        ? []
        : [
            me.narrowed === undefined
              ? `Others mention this profile as @${me.actor.handle}. It has exactly ${me.role === "service" ? "the service's" : "your"} access.`
              : `Others mention this profile as @${me.actor.handle}.`,
          ]),
      ...(me.narrowed === undefined
        ? []
        : [
            `You act under a limit${me.narrowed.expiresAt === null ? "" : `, with a token that expires ${me.narrowed.expiresAt}`}: less than whoever it is from, and no changing grants, registering watchers, scheduling posts or minting tokens.`,
          ]),
      `Using the ${handle.name} vibe at ${url}. There you can:`,
      formatCan(me.can ?? {}),
    ].join("\n"),
    { ...me, vibe: handle.name, url },
  );
  return 0;
}

async function login({ flags, config, out }: Session, args: string[]): Promise<number> {
  const url = args[0] ?? flags.url;
  if (!url) throw new UsageError("Usage: vibe login <url> [--token <TOKEN>]");
  // A token given now, not the one a login saved before: logging in again starts over.
  const given =
    flags.token ??
    process.env["VIBE_TOKEN"] ??
    (process.stdin.isTTY ? undefined : (await Bun.stdin.text()).trim());

  if (given) {
    const me = await vibe({ url, token: given }).whoami();
    const path = await saveConfig({ ...config, url, token: given });
    out(`Logged in as ${me.actor.handle}. Saved to ${path}.`, { actor: me.actor, config: path });
    return 0;
  }

  // No token: sign in through GitHub, in a browser on any device.
  let signed: Awaited<ReturnType<typeof deviceLogin>>;
  try {
    signed = await deviceLogin({
      url,
      onCode(code) {
        const minutes = Math.max(1, Math.round(code.expiresIn / 60));
        // On stderr, so stdout stays one document for a program.
        console.error(
          [
            `Open ${code.verificationUri} and enter the code:`,
            "",
            `  ${code.userCode}`,
            "",
            `Waiting for you to approve it there. The code lasts ${minutes} minutes.`,
          ].join("\n"),
        );
      },
    });
  } catch (error) {
    if (error instanceof VibeError && error.code === "login_unavailable") {
      throw new UsageError(
        "This Vibe has no GitHub sign-in. Pass your token with --token, in VIBE_TOKEN, or on stdin.",
      );
    }
    throw error;
  }
  const path = await saveConfig({ ...config, url, token: signed.token });
  out(
    `Logged in as ${signed.user.handle}${signed.created ? ", and added to the team" : ""}. Saved to ${path}.`,
    { user: signed.user, created: signed.created, config: path },
  );
  return 0;
}

async function channels({ client, flags, out }: Session, args: string[]): Promise<number> {
  const [verb, path] = args;
  if (verb !== undefined) {
    if (verb !== "create" || !path) {
      throw new UsageError("Usage: vibe channels create <channel> [--private]");
    }
    const made = await client().createChannel(path, { private: flags.private });
    const lines = [made.created ? `created ${path}` : `${path} already exists`];
    if (made.grants?.[0]) {
      lines.push(
        `Only you can use it. To let someone in: vibe grants update ${made.grants[0].id} --add-user <handle>`,
      );
    }
    out(lines.join("\n"), made);
    return 0;
  }

  const list = await client().channels();
  out(
    list.length > 0
      ? list.map((channel) => channel.path).join("\n")
      : "No channels yet. The first post creates one.",
    {
      channels: list,
    },
  );
  return 0;
}

async function grants({ client, flags, out }: Session, args: string[]): Promise<number> {
  const [verb, target] = args;
  const handle = client();
  const named = (
    people: readonly string[] | undefined,
    machines: readonly string[] | undefined,
  ): GrantPrincipalInput[] => [
    ...(people ?? []).map((name) => ({ kind: "user" as const, handle: name.replace(/^@/, "") })),
    ...(machines ?? []).map((name) => ({ kind: "service" as const, name: name.replace(/^@/, "") })),
  ];
  const can = () => canFrom(flags.can);

  switch (verb) {
    case undefined:
    case "list": {
      const list = await handle.grants();
      out(list.map(formatGrant).join("\n\n"), { grants: list });
      return 0;
    }
    case "create": {
      const principals = named(flags.user, flags.service);
      if (flags["all-users"]) principals.push({ kind: "all-users" });
      if (flags["all-services"]) principals.push({ kind: "all-services" });
      if (flags.everyone) principals.push({ kind: "everyone" });
      const gives = can();
      if (principals.length === 0 || !gives) {
        throw new UsageError(
          "Usage: vibe grants create (--user <HANDLE>... | --service <NAME>... | --all-users | --all-services | --everyone) --can <PATTERN=PERMS>...",
        );
      }
      const grant = await handle.createGrant({ principals, can: gives });
      out(`created ${grant.id}`, { grant });
      return 0;
    }
    case "update": {
      if (!target) {
        throw new UsageError(
          "Usage: vibe grants update <grant> [--add-user H] [--remove-user H] [--add-service N] [--remove-service N] [--can PATTERN=PERMS]",
        );
      }
      const grant = await handle.updateGrant(target, {
        add: named(flags["add-user"], flags["add-service"]),
        remove: named(flags["remove-user"], flags["remove-service"]),
        can: can(),
      });
      out(`updated ${grant.id}`, { grant });
      return 0;
    }
    case "explain": {
      if (!target) {
        throw new UsageError(
          "Usage: vibe grants explain [--user <HANDLE> | --service <NAME>] <channel>",
        );
      }
      const explained = await handle.explain(target, {
        user: flags.user?.[0]?.replace(/^@/, ""),
        service: flags.service?.[0]?.replace(/^@/, ""),
      });
      out(formatExplanation(explained), explained);
      return 0;
    }
    case "revoke": {
      if (!target) throw new UsageError("Usage: vibe grants revoke <grant>");
      const grant = await handle.revokeGrant(target);
      out(`revoked ${grant.id}`, { grant });
      return 0;
    }
    default:
      throw new UsageError(`Unknown grants command "${verb}". Run \`vibe help\`.`);
  }
}

/** Reads `--can 'pattern=permissions'` flags into a map, or `undefined` when there are none. */
function canFrom(inputs: readonly string[] | undefined): CanInput | undefined {
  if (!inputs) return undefined;
  const map: CanInput = {};
  for (const [pattern, given] of Object.entries(pairs(inputs, "--can", true))) {
    map[pattern] =
      given === "all" || given === "none" ? given : (given.split(",") as CanInput[string]);
  }
  return map;
}

/**
 * `vibe token create`: mints a short-lived token that writes as one profile
 * and can do no more than `--can` allows, to hand to an agent or a job.
 */
async function mintToken({ client, flags, out }: Session, args: string[]): Promise<number> {
  const usage =
    "Usage: vibe token create --as <PROFILE> --can <PATTERN=PERMS>... [--ttl <DURATION>]";
  const handle = client();
  const can = canFrom(flags.can);
  if (args[0] !== "create" || !can || handle.profile === null) throw new UsageError(usage);

  const minted = await handle.createToken({ can, ttl: flags.ttl });
  // Just the token on stdout, so a script can keep it: VIBE_TOKEN=$(vibe token create …)
  out(minted.token, minted);
  if (!flags.json) {
    console.error(
      [
        `A token that writes as ${minted.profile} until ${minted.expiresAt}, shown this once. It can:`,
        formatCan(minted.can),
      ].join("\n"),
    );
  }
  return 0;
}

async function actors({ client, out }: Session): Promise<number> {
  const list = await client().actors();
  out(list.map(formatActor).join("\n"), { actors: list });
  return 0;
}

async function read({ client, flags, out }: Session, args: string[]): Promise<number> {
  const target = args[0];
  if (target?.startsWith("msg_")) {
    const thread = await client().thread(target);
    out(formatThread(thread), thread);
    return 0;
  }

  const page = await client().threads({
    channel: target,
    by: flags.by,
    mentions: flags.mentions,
    source: flags.source,
    label: flags.label,
    after: flags.after,
    limit: flags.limit === undefined ? undefined : integer(flags.limit, "--limit"),
  });
  const next = `vibe read${target ? ` ${target}` : ""} --after ${page.cursor}`;
  const listing =
    page.threads.length > 0 ? page.threads.map(formatSummary).join("\n\n") : "Nothing here yet.";
  out(`${listing}\n\nRead what's new since:\n  ${next}`, { ...page, next });
  return 0;
}

async function post(
  { client, flags, out }: Session,
  args: string[],
  replyOnly = false,
): Promise<number> {
  const [target, ...words] = args;
  const usage = replyOnly
    ? "Usage: vibe reply <id> [text]"
    : "Usage: vibe post <channel|id> [text]";
  if (!target) throw new UsageError(usage);
  const isReply = target.startsWith("msg_");
  if (replyOnly && !isReply) throw new UsageError(`${usage}\n"${target}" is not a message ID.`);
  if (flags.after !== undefined && !isReply) {
    throw new UsageError(
      "--after is for replies: it lands the reply only while that message is the newest.",
    );
  }

  const handle = client();
  const text = await readText(flags.file, words.join(" "));
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

  // With --schema the text is the data, so the message itself has none.
  const blocks = flags.schema === undefined ? undefined : [blockFrom(flags.schema, text)];
  const body = blocks ? "" : text;
  const options = {
    attachments,
    idempotencyKey: flags["idempotency-key"],
    labels: flags.label ? pairs(flags.label, "--label") : undefined,
    blocks,
    noSync: flags["no-sync"],
  };
  if (isReply && flags.sync !== undefined) {
    throw new UsageError(
      "--sync goes with a new thread. To sync a thread that exists: vibe sync <id> <target>",
    );
  }
  const message = isReply
    ? await handle.reply(target, body, { ...options, after: flags.after })
    : await handle.post(target, body, { ...options, sync: flags.sync });
  // Just the ID, so a script can chain: id=$(vibe post dev "…")
  out(message.id, { message });
  reportMentions(message, flags);
  return 0;
}

/** Says on stderr who a write mentioned, and what it wrote as a mention that reached no one. */
function reportMentions(message: Written, flags: Flags): void {
  if (flags.json) return;
  for (const mention of message.mentions) {
    console.error(`mentioned @${mention.handle}`);
  }
  for (const written of message.unresolved) {
    console.error(
      `warning: ${written} matches no one you can see, so it stayed plain text. \`vibe actors\` lists handles.`,
    );
  }
}

async function edit({ client, flags, out }: Session, args: string[]): Promise<number> {
  const [id, ...words] = args;
  if (!id?.startsWith("msg_")) throw new UsageError("Usage: vibe edit <id> [text]");
  const text = await readText(flags.file, words.join(" "));
  // With --schema the text is new data, and the message keeps the text it has.
  const change = flags.schema === undefined ? text : { blocks: [blockFrom(flags.schema, text)] };
  const message = await client().edit(id, change, { revision: revision(flags) });
  out(`edited ${id}`, { message });
  if (message) reportMentions(message, flags);
  return 0;
}

async function remove({ client, flags, out }: Session, args: string[]): Promise<number> {
  const [id] = args;
  if (!id?.startsWith("msg_")) throw new UsageError("Usage: vibe delete <id>");
  const message = await client().delete(id, { revision: revision(flags) });
  out(`deleted ${id}`, { message });
  return 0;
}

async function react({ client, flags, out }: Session, args: string[]): Promise<number> {
  const [id, emoji] = args;
  if (!id?.startsWith("msg_") || !emoji) {
    throw new UsageError("Usage: vibe react <id> <emoji> [--remove]");
  }
  const message = await client().react(id, emoji, { remove: flags.remove });
  out(`${flags.remove ? "removed reaction from" : "reacted to"} ${id}`, { message });
  return 0;
}

function revision(flags: Flags): number | undefined {
  const given = flags["if-revision"];
  return given === undefined ? undefined : integer(given, "--if-revision");
}

async function label({ client, flags, out }: Session, args: string[]): Promise<number> {
  const [id, ...sets] = args;
  const usage = "Usage: vibe label <id> [k=v]... [--unset K] [--if k=v] [--if-unset K]";
  if (!id?.startsWith("msg_")) throw new UsageError(usage);
  const unset = flags.unset ?? [];
  if (sets.length === 0 && unset.length === 0) throw new UsageError(usage);

  const conditions: Record<string, string | null> = pairs(flags.if ?? [], "--if");
  for (const key of flags["if-unset"] ?? []) conditions[key] = null;
  const message = await client().label(id, {
    set: pairs(sets, "label"),
    unset,
    if: conditions,
  });
  out(`labeled ${id}`, { message });
  return 0;
}

/** Reads `k=v` arguments into an object. */
function pairs(
  inputs: readonly string[],
  what: string,
  valueRequired = false,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of inputs) {
    const equals = input.indexOf("=");
    if (equals < 1 || (valueRequired && equals === input.length - 1)) {
      throw new UsageError(`${what} takes key=value, not "${input}".`);
    }
    out[input.slice(0, equals)] = input.slice(equals + 1);
  }
  return out;
}

/** The filters `tail` and `wait` share, from a channel or message ID and the flags. */
async function following(
  session: Session,
  target: string | undefined,
): Promise<Filters & { after?: string | undefined }> {
  const { flags } = session;
  if (!target?.startsWith("msg_")) {
    return {
      channel: target,
      by: flags.by,
      mentions: flags.mentions,
      source: flags.source,
      re: flags.re,
      label: flags.label,
      after: flags.after,
    };
  }
  // A message ID means: in that message's thread, whatever comes after it.
  const thread = await session.client().thread(target);
  return {
    by: flags.by,
    mentions: flags.mentions,
    source: flags.source,
    re: thread.message.id,
    label: flags.label,
    after: flags.after ?? target,
  };
}

async function tail(session: Session, args: string[]): Promise<number> {
  const filters = await following(session, args[0]);
  const all = session.flags.all === true;
  for await (const event of session.client().events({ ...filters, all })) {
    session.out(formatEvent(event), event);
  }
  return 0;
}

async function wait(session: Session, args: string[]): Promise<number> {
  const { flags, out } = session;
  const timeout = flags.timeout ?? "30m";
  const filters = await following(session, args[0]);
  const event = await session.client().wait(filters, { timeout: parseDuration(timeout) });
  if (!event) throw new VibeError("timeout", `Nothing matched in ${timeout}.`, 0);

  const scope = [
    args[0] && !args[0].startsWith("msg_") ? args[0] : undefined,
    filters.re ? `--re ${filters.re}` : undefined,
    flags.by ? `--by ${flags.by}` : undefined,
    flags.mentions ? `--mentions=${flags.mentions}` : undefined,
    flags.source ? `--source ${flags.source}` : undefined,
    ...(flags.label ?? []).map((filter) => `--label '${filter}'`),
  ].filter((part) => part !== undefined);
  const next = ["vibe wait", ...scope, `--after ${event.cursor}`].join(" ");
  // A new message says itself. Anything else that happened to a message is
  // said first, in a line, since the message printed under it looks the same
  // as it did before but for a label or a state.
  const body = !event.message
    ? formatEvent(event)
    : event.type === "message.posted"
      ? formatMessage(event.message)
      : `${formatEvent(event)}\n\n${formatMessage(event.message)}`;
  out(`${body}\n\nWait on from here:\n  ${next}`, { event, next });
  return 0;
}

async function download({ client, flags }: Session, args: string[]): Promise<number> {
  const [id, destination] = args;
  if (!id) throw new UsageError("Usage: vibe download <attachment-id> [path|-]");
  const file = await client().download(id);
  const data = await file.response.arrayBuffer();
  if (destination === "-") {
    await Bun.write(Bun.stdout, data);
    return 0;
  }
  // The name comes from another person. Only its last segment is used.
  const path = resolve(destination ?? basename(file.name));
  await Bun.write(path, data);
  console.log(
    flags.json
      ? JSON.stringify({ path, name: file.name, size: data.byteLength })
      : `Saved ${path} (${bytes(data.byteLength)})`,
  );
  return 0;
}

async function admin({ flags, config, url, out }: Session, args: string[]): Promise<number> {
  const [noun, verb, handle, tokenId] = args;
  const linking = verb === "link";
  const revoking = verb === "revoke";
  if (
    noun !== "user" ||
    !["create", "link", "tokens", "revoke"].includes(verb ?? "") ||
    !handle ||
    (revoking && !tokenId)
  ) {
    throw new UsageError(
      [
        "Usage: vibe admin user create <handle> [--role <ROLE>] [--github <LOGIN>] [--save]",
        "       vibe admin user link <handle> --github <LOGIN>",
        "       vibe admin user tokens <handle>",
        "       vibe admin user revoke <handle> <token-id>",
      ].join("\n"),
    );
  }
  if (linking && !flags.github) {
    throw new UsageError("Usage: vibe admin user link <handle> --github <LOGIN>");
  }
  if (!url) throw new UsageError("Pass --url or set VIBE_URL: the Vibe to add the user to.");
  const secret = flags["admin-secret"] ?? process.env["VIBE_ADMIN_SECRET"];
  if (!secret)
    throw new UsageError(
      "Pass --admin-secret or set VIBE_ADMIN_SECRET: the deployment's operator secret.",
    );

  const base = `${url.replace(/\/+$/, "")}/v1/admin/users`;
  if (verb === "tokens" || revoking) {
    const held = `${base}/${encodeURIComponent(handle)}/tokens`;
    const response = await fetch(revoking ? `${held}/${encodeURIComponent(tokenId ?? "")}` : held, {
      method: revoking ? "DELETE" : "GET",
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!response.ok) throw await failure(response);
    const body = (await response.json()) as { tokens?: HeldToken[]; token?: HeldToken };
    if (body.token) out(revokedLine(body.token), body);
    else {
      const list = body.tokens ?? [];
      out(
        list.length > 0
          ? list.map((token) => tokenLine(token)).join("\n")
          : `${handle} has no token that works.`,
        body,
      );
    }
    return 0;
  }
  const response = await fetch(linking ? `${base}/${encodeURIComponent(handle)}/github` : base, {
    method: linking ? "PUT" : "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(
      linking ? { github: flags.github } : { handle, role: flags.role, github: flags.github },
    ),
  });
  const body = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
    hint?: string;
    user?: { handle: string; role: string };
    token?: string;
    github?: string;
  } | null;
  if (!response.ok || !body?.user || (!linking && !body.token)) {
    throw new VibeError(
      body?.code ?? "http_error",
      body?.message ?? `Vibe answered ${response.status}.`,
      response.status,
      body?.hint,
    );
  }
  if (linking) {
    out(
      `${body.user.handle} signs in as the GitHub account ${body.github}, from their next \`vibe login\`.`,
      body,
    );
    return 0;
  }

  const lines = [`Added ${body.user.handle} as ${body.user.role}.`];
  if (flags.save) {
    lines.push(
      `Logged in as ${body.user.handle}. Saved to ${await saveConfig({ ...config, url, token: body.token })}.`,
    );
  } else {
    lines.push("Their token, shown this once:", `  ${body.token}`);
  }
  if (flags.github) {
    lines.push(`They can also sign in as the GitHub account ${flags.github}: vibe login ${url}`);
  }
  out(lines.join("\n"), flags.save ? { user: body.user, config: configPath() } : body);
  return 0;
}

/** Whether two addresses are the same Vibe: the same scheme, host and port. */
function sameVibe(one: string | undefined, other: string | undefined): boolean {
  if (one === undefined || other === undefined) return false;
  try {
    return new URL(one).origin === new URL(other).origin;
  } catch {
    return false;
  }
}

/** Prints a failure for a person, or as one JSON document on stderr for a program. */
function report(error: unknown, json: boolean): number {
  const usage = error instanceof UsageError;
  const reason = error instanceof VibeError ? error.code : usage ? "usage" : "error";
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof VibeError ? error.hint : undefined;
  const retryAfter = error instanceof VibeError ? error.retryAfter : undefined;
  if (json)
    console.error(
      JSON.stringify({
        reason,
        message,
        ...(hint === undefined ? {} : { hint }),
        ...(retryAfter === undefined ? {} : { retryAfter }),
      }),
    );
  else
    console.error(
      [usage ? message : `${reason}: ${message}`, ...(hint === undefined ? [] : [hint])].join("\n"),
    );
  return usage ? 2 : 1;
}

const argv = process.argv.slice(2);
// `serve` stops what it started before it exits. Everything else just stops.
if (argv[0] !== "serve") process.on("SIGINT", () => process.exit(130));

process.exit(await main(argv).catch((error: unknown) => report(error, argv.includes("--json"))));
