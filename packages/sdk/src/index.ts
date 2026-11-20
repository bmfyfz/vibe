import type {
  Actor,
  ActorsPage,
  Attachment,
  BlockInput,
  CancelScheduleResponse,
  CanInput,
  ChangeMessageResponse,
  Channel,
  ChannelsPage,
  CreateChannelResponse,
  CreateSchemaResponse,
  CreateServiceResponse,
  CreateTokenResponse,
  CreateWatcherResponse,
  EndSessionResponse,
  EventsPage,
  Explanation,
  Grant,
  GrantPrincipalInput,
  GrantResponse,
  GrantsPage,
  HeldToken,
  HeldTokensPage,
  LabelsRequest,
  Message,
  OpenSession,
  PostMessageRequest,
  PostMessageResponse,
  RevokeTokenResponse,
  Schedule,
  ScheduleResponse,
  SchedulesPage,
  Schema,
  SchemasPage,
  Service,
  ServiceResponse,
  ServicesPage,
  ServiceTokenResponse,
  SessionsPage,
  SyncedView,
  SyncInboxEntry,
  SyncInboxPage,
  SyncMapInput,
  SyncPlatform,
  SyncSource,
  SyncSourceResponse,
  SyncSourcesPage,
  SyncThreadResponse,
  ThreadDetail,
  ThreadsPage,
  Vibe,
  VibeEvent,
  VibesPage,
  Watcher,
  WatcherResponse,
  WatchersPage,
  Whoami,
} from "@vibe/contracts";
import { MAX_WAIT_SECONDS } from "@vibe/contracts/limits";

import { askAgainIn, failure, parseDuration, VibeError } from "./duration.ts";
import { defaultSocket, Live, type LiveSource, type OpenSocket } from "./live.ts";
import { VibeTasks } from "./tasks.ts";

export type {
  Actor,
  Attachment,
  Block,
  BlockInput,
  BrowserSession,
  Person,
  SignInWays,
  CanInput,
  Channel,
  CreateChannelResponse,
  CreateTokenResponse,
  DeviceLogin,
  EventsPage,
  Explanation,
  Grant,
  GrantPrincipal,
  GrantPrincipalInput,
  HeldToken,
  Message,
  OpenSession,
  Permission,
  Vibe,
  VibeEvent,
  Reaction,
  Schedule,
  ScheduleState,
  Schema,
  Service,
  SyncedView,
  SyncFailure,
  SyncInboxEntry,
  SyncMapInput,
  SyncMapping,
  SyncPlatform,
  SyncSource,
  SyncTarget,
  ThreadDetail,
  ThreadSummary,
  ThreadsPage,
  Watcher,
  WatcherDelivery,
  WatcherTail,
  Whoami,
} from "@vibe/contracts";
export { failure, VibeError, parseDuration } from "./duration.ts";
export type { LiveSocket, OpenSocket } from "./live.ts";
export { deviceLogin, type DeviceLoginOptions, type LoggedIn } from "./login.ts";
export { type SessionOptions, signIn, signInWays, signInWithGitHub, signOut } from "./session.ts";
export { type DeliveryProof, receiveDelivery, verifyDelivery } from "./watchers.ts";
export {
  type ClaimOptions,
  VibeTasks,
  type ReadyQuery,
  type TaskClaim,
  type TaskInput,
  type TasksQuery,
} from "./tasks.ts";
export type { ClaimedTask, Task, TaskDetail, TaskState } from "@vibe/contracts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface VibeOptions {
  /** Where Vibe is served. Defaults to `VIBE_URL`. */
  url?: string | undefined;
  /** The token to act with. Defaults to `VIBE_TOKEN`. */
  token?: string | undefined;
  /** Which of the team's vibes to use. Defaults to `VIBE_NAME`, then `general`. */
  name?: string | undefined;
  /** The profile to write as, such as an agent's name. Defaults to `VIBE_PROFILE`. */
  profile?: string | null | undefined;
  fetch?: Fetch | undefined;
  /**
   * How `events` and `wait` learn there is something new. By default they
   * listen on a WebSocket, where Vibe says only that the vibe's log has moved,
   * and ask for events when it has. Where the socket can't be had, they wait
   * with a long-poll instead, as they do with `false`.
   *
   * `repoll` is how long to go without hearing anything before asking anyway,
   * in case a poke went missing: a duration such as `25s`, the default, or
   * milliseconds.
   */
  live?: boolean | { repoll?: string | number | undefined } | undefined;
  /**
   * Opens the WebSocket, for a runtime whose own can't send headers with the
   * handshake. Defaults to the global `WebSocket`, which can in Bun and Node.
   */
  webSocket?: OpenSocket | undefined;
}

/** How long a listening handle goes without a poke before it asks anyway. */
const REPOLL = "25s";

/** The filters that reading, following and waiting share. An item must match all of them. */
export interface Filters {
  /** A channel, or a subtree such as `www/`. */
  channel?: string | undefined;
  /**
   * An author: a handle, `me`, or an actor ID. A person's handle covers the
   * profiles that write with their access. With `=` in front, `=ada`, it is
   * that one actor and none of their profiles.
   */
  by?: string | undefined;
  /** Only events in the thread whose root has this ID. */
  re?: string | undefined;
  /**
   * Labels on the message or on its thread's root: `{ state: "open" }`, or
   * filters such as `["state=open|draft", "pr"]`. Every one must match.
   */
  label?: Record<string, string> | string[] | string | undefined;
  /** Mentioning an actor: a handle, an actor ID, or `me` for whoever this handle writes as. */
  mentions?: string | undefined;
  /** From a source: a sync entry's key, such as `slack`, or `vibe` for what was written on the vibe. */
  source?: string | undefined;
}

/** A message this handle just wrote, with what its text wrote as a mention that stayed plain text. */
export type Written = Message & { unresolved: string[] };

export interface WriteOptions {
  /** IDs of files from `upload`. */
  attachments?: string[] | undefined;
  /** Posts once, even when a retry sends the same key again. */
  idempotencyKey?: string | undefined;
  /** Labels on the new message, such as `{ state: "open" }`. */
  labels?: Record<string, string> | undefined;
  /**
   * Structured data to carry, from `block`. Vibe checks each block against the
   * schema it names, and refuses the write with `invalid_block` or
   * `schema_not_found`. With data, the text can be empty.
   */
  blocks?: BlockInput[] | undefined;
  /**
   * Keep the message off every synced platform. On a thread's root, it keeps
   * the whole thread off, even if someone syncs the thread later.
   */
  noSync?: boolean | undefined;
}

export interface PostOptions extends WriteOptions {
  /**
   * Synced platform targets the new thread also starts in or joins, such as
   * `slack:#incidents`. It takes `sync` in the channel, and can't go with `noSync`.
   */
  sync?: string | string[] | undefined;
}

/** What a schedule posts, and when. Give `in` or `at` to post once, or `every` to repeat. */
export interface ScheduleOptions {
  text?: string | undefined;
  labels?: Record<string, string> | undefined;
  /** Structured data each post carries, from `block`. */
  blocks?: BlockInput[] | undefined;
  /** Keep each post off every synced platform. */
  noSync?: boolean | undefined;
  /** Post once, this long from now: a duration such as `1d`, or milliseconds. With `every`, the first time. */
  in?: string | number | undefined;
  /** Post once at this time. With `every`, the first time. A string is ISO 8601 with its zone, such as `2026-11-02T09:00:00Z`. */
  at?: Date | string | undefined;
  /** Repeat at this interval, such as `30m`. The shortest is one minute. */
  every?: string | number | undefined;
  /** Repeat for this long, such as `24h`, counted from the first post. */
  for?: string | number | undefined;
  /** Post this many times in all. */
  times?: number | undefined;
  /** Repeat until this time. */
  until?: Date | string | undefined;
}

/** What to do to a message's labels. See `label`. */
export type LabelChange = LabelsRequest;

export interface UploadFile {
  name: string;
  data: Blob | ArrayBuffer | Uint8Array | string;
  type?: string | undefined;
}

type Query = Record<string, string | number | readonly string[] | undefined>;

/**
 * Structured data for a message: an object that must match a registered
 * schema, named by its ID. Pass the result in `blocks` when you write, and
 * read it back, parsed, in the message's `blocks`.
 *
 * @param schema A schema's ID, such as `sandbox@1`.
 */
export function block(schema: string, data: Record<string, unknown>): BlockInput {
  return { schema, data };
}

/** Creates a handle on one vibe. Nothing is sent until you call a method. */
export function vibe(options: VibeOptions = {}): VibeHandle {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const url = options.url ?? env?.["VIBE_URL"];
  if (!url) {
    throw new VibeError(
      "no_vibe",
      "There is no vibe to use.",
      0,
      "Pass `url`, set VIBE_URL, or run `vibe login`.",
    );
  }
  const open = options.live === false ? null : (options.webSocket ?? defaultSocket());
  const repoll = (typeof options.live === "object" ? options.live.repoll : undefined) ?? REPOLL;
  return new VibeHandle(
    url.replace(/\/+$/, ""),
    options.token ?? env?.["VIBE_TOKEN"],
    options.name ?? env?.["VIBE_NAME"] ?? "general",
    options.fetch ?? ((input, init) => fetch(input, init)),
    (options.profile === undefined ? env?.["VIBE_PROFILE"] : options.profile) || null,
    open && { open, repollMs: parseDuration(repoll) },
  );
}

export class VibeHandle {
  constructor(
    readonly url: string,
    private readonly token: string | undefined,
    /** The name of the vibe this handle uses. */
    readonly name: string,
    private readonly fetcher: Fetch,
    /** The profile this handle writes as, or `null` when it writes as the token's owner. */
    readonly profile: string | null = null,
    /** How to listen for news of the vibe, or `null` to wait with long-polls only. */
    private readonly source: LiveSource | null = null,
    /** What every call is held to, each limit narrowing what the ones before it left. */
    private readonly limits: readonly CanInput[] = [],
  ) {}

  /**
   * Returns a handle that writes as a profile, such as an agent's name. Vibe
   * shows the profile with who is behind it, such as "fx via ada". The profile
   * has its own handle and mentions, and the access of the token.
   *
   * Pass `can` to hold the handle to less: a map from channel pattern to
   * permissions, as a grant takes it. Vibe enforces it on every call, and it
   * only narrows what the token could already do. A narrowed handle can't
   * change grants, register watchers, schedule posts or mint tokens, whatever
   * its `can` says, and its own `as()` only narrows it further. Hand an
   * agent's tool a narrowed handle instead of your own.
   *
   * The limit travels with each request, so it binds this handle and not
   * whoever holds the token. To hand a limit to another process, mint a
   * token for it with `createToken`.
   *
   * @param profile A name of up to 32 letters, numbers and hyphens that starts
   *   with a letter. `null` writes as yourself, whatever `VIBE_PROFILE` says.
   */
  as(profile: string | null, options: { can?: CanInput | undefined } = {}): VibeHandle {
    const limits = options.can === undefined ? this.limits : [...this.limits, options.can];
    return new VibeHandle(
      this.url,
      this.token,
      this.name,
      this.fetcher,
      profile,
      this.source,
      limits,
    );
  }

  /**
   * Mints a delegated token: a short-lived token for this vibe that writes as
   * one profile and can do no more than `can` allows, for a sandboxed agent or
   * a job that shouldn't hold your own. Use it as any token: `vibe({ token })`,
   * or `VIBE_TOKEN`.
   *
   * It gives nothing you don't have at each pattern, and never more than you
   * have when it is used. Whoever holds it can't change grants, register
   * watchers, schedule posts or mint tokens.
   *
   * @param options.profile The profile the token writes as. Defaults to this
   *   handle's own, from `as()`. One of the two is required.
   * @param options.ttl How long it lasts: a duration such as `1h`, the
   *   default, or milliseconds. At most 24 hours.
   * @returns The token, shown this once, with when it expires.
   */
  async createToken(options: {
    profile?: string | undefined;
    can: CanInput;
    ttl?: string | number | undefined;
  }): Promise<CreateTokenResponse> {
    const profile = options.profile ?? this.profile;
    if (!profile) {
      throw new VibeError(
        "invalid_profile",
        "A delegated token writes as a profile.",
        0,
        "Pass `profile`, or mint it from a handle that has one: vibe().as('fixer').createToken(…).",
      );
    }
    return this.json("POST", this.path("/tokens"), {
      json: { profile, can: options.can, ttl: seconds(options.ttl) },
    });
  }

  /**
   * The tokens you hold that work: your own, and the delegated ones minted
   * from them, each by its ID and what it is for. Never a secret: that was
   * shown once, when the token was minted. `current` marks the one this
   * handle is using.
   *
   * @throws `forbidden` from a narrowed handle or a delegated token.
   */
  async tokens(): Promise<HeldToken[]> {
    return (await this.json<HeldTokensPage>("GET", "/v1/tokens")).tokens;
  }

  /**
   * Revokes one of your tokens by its ID, `tok_…` or `dt_…`. It stops working
   * from the next request, and so does every delegated token minted with it
   * and every browser session opened with it. Revoking one that is already
   * revoked changes nothing and fails nothing.
   *
   * It may be the token this handle uses: then this call is its last.
   *
   * @throws `token_not_found` for a token that isn't yours.
   */
  async revokeToken(id: string): Promise<HeldToken> {
    const path = `/v1/tokens/${encodeURIComponent(id)}`;
    return (await this.json<RevokeTokenResponse>("DELETE", path)).token;
  }

  /**
   * The browser sessions you have open, oldest first, each with what its
   * browser called itself. `current` marks the one a page is asking from.
   * A service has none.
   */
  async sessions(): Promise<OpenSession[]> {
    return (await this.json<SessionsPage>("GET", "/v1/sessions")).sessions;
  }

  /**
   * Ends one of your browser sessions from wherever you are. The browser
   * that holds it is signed out at its next request, and delegated tokens
   * minted from it stop working.
   *
   * @throws `session_not_found` for a session that isn't yours, or is over.
   */
  async endSession(id: string): Promise<void> {
    await this.json<EndSessionResponse>("DELETE", `/v1/sessions/${encodeURIComponent(id)}`);
  }

  /** The vibe's tasks: threads that agents are to do, with a state the vibe keeps. */
  get tasks(): VibeTasks {
    return new VibeTasks((method, path, init) => this.json(method, this.path(path), init));
  }

  /**
   * Who this handle writes as, on which vibe, and in `can` what it may do at
   * each channel pattern that decides something for it.
   */
  whoami(): Promise<Whoami> {
    return this.json("GET", this.path("/whoami"));
  }

  /** The team's vibes. */
  async vibes(): Promise<Vibe[]> {
    return (await this.json<VibesPage>("GET", "/v1/vibes")).vibes;
  }

  /** The team's people, and the agent profiles that have written, with their handles and actor IDs. */
  async actors(): Promise<Actor[]> {
    return (await this.json<ActorsPage>("GET", this.path("/actors"))).actors;
  }

  /** The channels you can read. */
  async channels(): Promise<Channel[]> {
    return (await this.json<ChannelsPage>("GET", this.path("/channels"))).channels;
  }

  /**
   * Creates a channel before anything posts to it. A first post needs no such
   * step. A channel that already exists stays as it is, and `created` is `false`.
   *
   * @param options.private Close the channel to everyone but you. This makes a
   *   grant that lets you in and a grant that closes the path to everyone else,
   *   returned in `grants`. To let others in, add them to yours with
   *   `updateGrant`. Fails with `channel_exists` when the path is already in
   *   use, and with `channel_granted` when another grant already reaches it.
   */
  createChannel(
    path: string,
    options: { private?: boolean | undefined } = {},
  ): Promise<CreateChannelResponse> {
    return this.json("POST", this.path("/channels"), {
      json: { path, private: options.private },
    });
  }

  /** The vibe's grants: who can do what in which channels. Takes `manage` at `*`. */
  async grants(): Promise<Grant[]> {
    return (await this.json<GrantsPage>("GET", this.path("/grants"))).grants;
  }

  /**
   * Gives permissions at channel patterns to the principals named: a person
   * as `{ kind: "user", handle }`, a service as `{ kind: "service", name }`,
   * or a group, `all-users`, `all-services` or `everyone`.
   *
   * For a caller and a channel, the most specific pattern wins, then the
   * closest principal, tied grants add up, and the caller's role caps the
   * result. So to close a subtree to all but a few, grant it to them first,
   * then give `everyone` `none` there: closing it closes it to you too.
   *
   * @param grant.can A map from pattern, such as `security/` or `*`, to
   *   `"all"`, `"none"`, or a list of permissions.
   */
  async createGrant(grant: { principals: GrantPrincipalInput[]; can: CanInput }): Promise<Grant> {
    return (await this.json<GrantResponse>("POST", this.path("/grants"), { json: grant })).grant;
  }

  /** Adds and removes principals on a grant, and with `can` replaces what it gives. */
  async updateGrant(
    id: string,
    change: {
      add?: GrantPrincipalInput[] | undefined;
      remove?: GrantPrincipalInput[] | undefined;
      can?: CanInput | undefined;
    },
  ): Promise<Grant> {
    const path = this.path(`/grants/${encodeURIComponent(id)}`);
    return (await this.json<GrantResponse>("PATCH", path, { json: change })).grant;
  }

  /** Revokes a grant. What it gave stops from the next request. */
  async revokeGrant(id: string): Promise<Grant> {
    const path = this.path(`/grants/${encodeURIComponent(id)}`);
    return (await this.json<GrantResponse>("DELETE", path)).grant;
  }

  /**
   * Says which grant decides a channel, and what it comes to.
   *
   * @param who A person, as `{ user }` with their handle, or a service, as
   *   `{ service }` with its name. Omit it to explain your own access.
   *   Explaining someone else's takes `manage` at `*`.
   */
  explain(
    channel: string,
    who: { user?: string | undefined; service?: string | undefined } = {},
  ): Promise<Explanation> {
    return this.json("POST", this.path("/grants/explain"), {
      json: { channel, user: who.user, service: who.service },
    });
  }

  /**
   * The team's services: machine principals, such as a CI job or a worker,
   * that act with tokens of their own and no person behind them.
   */
  async services(): Promise<Service[]> {
    return (await this.json<ServicesPage>("GET", "/v1/services")).services;
  }

  /**
   * Adds a service to the team, as a team owner. Its name is its handle, so
   * people mention it as `@name` and grants name it as `{ kind: "service", name }`.
   *
   * A new vibe's `g2` lets every service read, post, react and label in every
   * channel. Give one service more, or less, with a grant that names it.
   *
   * @returns The service and its first token. The token is shown this once.
   * @throws `handle_taken` when a person or a service has the name, or had it.
   */
  createService(input: {
    name: string;
    description?: string | undefined;
  }): Promise<CreateServiceResponse> {
    return this.json("POST", "/v1/services", { json: input });
  }

  /** Mints another token for a service, as a team owner. Its earlier tokens keep working. */
  async createServiceToken(
    name: string,
    options: { label?: string | undefined } = {},
  ): Promise<string> {
    const path = `/v1/services/${encodeURIComponent(name)}/tokens`;
    return (await this.json<ServiceTokenResponse>("POST", path, { json: options })).token;
  }

  /** A service's tokens that work, as a team owner: each by its ID and its label, never its secret. */
  async serviceTokens(name: string): Promise<HeldToken[]> {
    const path = `/v1/services/${encodeURIComponent(name)}/tokens`;
    return (await this.json<HeldTokensPage>("GET", path)).tokens;
  }

  /**
   * Revokes one of a service's tokens, as a team owner. The service's other
   * tokens keep working. Delegated tokens minted with it stop with it.
   *
   * @throws `token_not_found` for a token that isn't that service's.
   */
  async revokeServiceToken(name: string, id: string): Promise<HeldToken> {
    const path = `/v1/services/${encodeURIComponent(name)}/tokens/${encodeURIComponent(id)}`;
    return (await this.json<RevokeTokenResponse>("DELETE", path)).token;
  }

  /**
   * Removes a service, as a team owner. Its tokens stop working from the next
   * request. What it wrote stays, under its name.
   */
  async deleteService(name: string): Promise<Service> {
    const path = `/v1/services/${encodeURIComponent(name)}`;
    return (await this.json<ServiceResponse>("DELETE", path)).service;
  }

  /** A channel's latest threads, one summary each, and the cursor to read what's new since. */
  threads(
    query: Filters & { after?: string | undefined; limit?: number | undefined } = {},
  ): Promise<ThreadsPage> {
    const { channel, by, after, limit } = query;
    return this.json("GET", this.path("/threads"), {
      query: {
        channel,
        by,
        after,
        limit,
        mentions: query.mentions,
        source: query.source,
        label: labelFilters(query.label),
      },
    });
  }

  /** The whole thread, from the ID of any message in it. */
  thread(id: string): Promise<ThreadDetail> {
    return this.json("GET", this.path(`/threads/${encodeURIComponent(id)}`));
  }

  /**
   * Starts a thread in a channel. The first post in a channel creates the channel.
   *
   * A handle in the text, such as `@ada` or `@ada/fx`, mentions the one actor
   * you can see with that handle. The returned `mentions` says who the message
   * mentions, and `unresolved` what stayed plain text.
   */
  async post(channel: string, text: string, options: PostOptions = {}): Promise<Written> {
    const { sync, ...rest } = options;
    const targets = sync === undefined || Array.isArray(sync) ? sync : [sync];
    return this.write({ channel, text, ...rest, ...(targets ? { sync: targets } : {}) });
  }

  /**
   * Replies in the thread that holds a message.
   *
   * @param options.after Reply only while this message is still the thread's
   *   newest. Otherwise the call fails with `newer_message`.
   */
  async reply(
    id: string,
    text: string,
    options: WriteOptions & { after?: string | undefined } = {},
  ): Promise<Written> {
    return this.write({ re: id, text, ...options });
  }

  /**
   * Sets and removes labels on a message.
   *
   * @param change.if What the labels must be before the change: a value, or
   *   `null` for a label that mustn't be set. When one doesn't match, nothing
   *   changes and the call fails with `label_conflict`, so of two writers that
   *   race on a condition, one lands.
   * @returns The message as the change left it, or `null` when you can't read
   *   its channel: `label` alone lets you make the change, not see it.
   */
  async label(id: string, change: LabelChange): Promise<Message | null> {
    const path = this.path(`/messages/${encodeURIComponent(id)}/labels`);
    return (await this.json<ChangeMessageResponse>("PUT", path, { json: change })).message;
  }

  /**
   * Replaces the text of a message you wrote, its data, or both. As yourself
   * you can edit what your profiles wrote. As a profile, only what that
   * profile wrote.
   *
   * @param change The new text, or `{ text, blocks }` with either or both.
   *   What you leave out stays as it is, and `blocks: []` removes the data.
   * @param options.revision Edit only while the message is still at this
   *   revision. Otherwise the call fails with `revision_conflict`.
   * @returns The message as the edit left it. Like `delete`, `react` and
   *   `label`, `null` in the one case where you can't read its channel.
   */
  async edit(
    id: string,
    change: string | { text?: string | undefined; blocks?: BlockInput[] | undefined },
    options: { revision?: number | undefined } = {},
  ): Promise<Written | null> {
    const path = this.path(`/messages/${encodeURIComponent(id)}`);
    const { text, blocks } = typeof change === "string" ? { text: change } : change;
    const json = { text, blocks, revision: options.revision };
    const { message, unresolved } = await this.json<ChangeMessageResponse>("PATCH", path, { json });
    return message && { ...message, unresolved: unresolved ?? [] };
  }

  /**
   * Deletes a message you wrote. It becomes a tombstone: its text, labels,
   * reactions and files are gone from every view, and its replies stay.
   *
   * @param options.revision Delete only while the message is still at this revision.
   */
  async delete(
    id: string,
    options: { revision?: number | undefined } = {},
  ): Promise<Message | null> {
    const path = this.path(`/messages/${encodeURIComponent(id)}`);
    const query = { revision: options.revision };
    return (await this.json<ChangeMessageResponse>("DELETE", path, { query })).message;
  }

  /**
   * Reacts to a message, once per emoji.
   *
   * @param emoji A short name such as `eyes`, `:eyes:`, or the emoji itself.
   * @param options.remove Take your reaction back instead.
   */
  async react(
    id: string,
    emoji: string,
    options: { remove?: boolean | undefined } = {},
  ): Promise<Message | null> {
    const path = this.path(
      `/messages/${encodeURIComponent(id)}/reactions/${encodeURIComponent(emoji)}`,
    );
    const method = options.remove ? "DELETE" : "PUT";
    return (await this.json<ChangeMessageResponse>(method, path)).message;
  }

  /**
   * Posts later, as you: a new thread when `target` is a channel, or a reply
   * when it is `{ re }` with the ID of any message in the thread. Each post is
   * made with the access you have when it fires, so a schedule stops, with
   * the state `stopped`, once you can no longer post there.
   *
   * The scheduler looks once a minute: a post goes out within a minute after
   * its time, and nothing repeats faster than `1m`.
   *
   * @throws `invalid_schedule` for a timing that says nothing or contradicts
   *   itself, and whatever the post itself would fail with now.
   */
  async schedule(
    target: string | { re: string },
    options: string | ScheduleOptions,
  ): Promise<Schedule> {
    const { text, labels, blocks, noSync, times, ...timing } =
      typeof options === "string" ? { text: options } : options;
    const json = {
      ...(typeof target === "string" ? { channel: target } : { re: target.re }),
      text,
      labels,
      blocks,
      noSync,
      in: seconds(timing.in),
      at: instant(timing.at),
      every: seconds(timing.every),
      for: seconds(timing.for),
      times,
      until: instant(timing.until),
    };
    const path = this.path("/schedules");
    return (await this.json<ScheduleResponse>("POST", path, { json })).schedule;
  }

  /**
   * The pending schedules you can see, oldest first: those in channels you can
   * read, and your own.
   *
   * @param query.re Only those that reply in the thread that holds this message.
   * @param query.all Include the schedules that are done, canceled or stopped.
   */
  async schedules(
    query: {
      channel?: string | undefined;
      by?: string | undefined;
      re?: string | undefined;
      all?: boolean | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<Schedule[]> {
    const { channel, by, re, limit } = query;
    const page = await this.json<SchedulesPage>("GET", this.path("/schedules"), {
      query: { channel, by, re, limit, all: query.all === true ? "true" : undefined },
    });
    return page.schedules;
  }

  /** One schedule, whether it is pending or has ended. */
  async getSchedule(id: string): Promise<Schedule> {
    const path = this.path(`/schedules/${encodeURIComponent(id)}`);
    return (await this.json<ScheduleResponse>("GET", path)).schedule;
  }

  /**
   * Calls a schedule off. You can cancel your own, or anyone's with `manage`
   * in the schedule's channel. `canceled` is `false` when it had already ended.
   */
  cancelSchedule(id: string): Promise<CancelScheduleResponse> {
    return this.json("DELETE", this.path(`/schedules/${encodeURIComponent(id)}`));
  }

  /** The vibe's watchers, with how each one's deliveries are going. Takes `manage` at `*`. */
  async watchers(): Promise<Watcher[]> {
    return (await this.json<WatchersPage>("GET", this.path("/watchers"))).watchers;
  }

  /**
   * Registers a watcher: a URL that Vibe posts each matching event to, from
   * now on. Takes `manage` at `*`, since a watcher carries what you can read
   * out of the vibe. It reads with your access, as it stands at each delivery.
   *
   * Each delivery is a `WatcherDelivery` as JSON, signed with the watcher's
   * secret: check it with `receiveDelivery` or `verifyDelivery`. Deliveries
   * arrive in order, each at least once. One that isn't answered with a 2xx
   * is sent again after a wait, and nothing newer is sent before it.
   *
   * The watcher writes as the profile that has its name: what `as(name)`
   * writes with your token never wakes it, so a receiver can answer in the
   * thread it was told about. Other watchers do hear it.
   *
   * @param watcher.name A profile name, unique in the vibe.
   * @param watcher.url Where to post: https, or http to the machine Vibe runs on.
   * @param watcher.all Also deliver the events that only keep the books, such
   *   as a task's lease renewals.
   * @returns The watcher, and its `secret`, shown this once.
   */
  createWatcher(
    watcher: Filters & { name: string; url: string; all?: boolean | undefined },
  ): Promise<CreateWatcherResponse> {
    const { name, url, channel, re, by, mentions, source, all } = watcher;
    return this.json("POST", this.path("/watchers"), {
      json: {
        name,
        url,
        channel,
        re,
        by,
        mentions,
        source,
        labels: labelFilters(watcher.label),
        all,
      },
    });
  }

  /**
   * Deletes a watcher, by its name or its ID: your own, or anyone's with
   * `manage` at `*`. What it had not been delivered yet, it never is.
   */
  async deleteWatcher(id: string): Promise<Watcher> {
    const path = this.path(`/watchers/${encodeURIComponent(id)}`);
    return (await this.json<WatcherResponse>("DELETE", path)).watcher;
  }

  /**
   * The vibe's sync entries: the platform accounts whose channels sync with
   * its channels, each with the channels it maps among those you can read.
   * Check them before you post something that shouldn't leave the vibe.
   */
  async sources(): Promise<SyncSource[]> {
    return (await this.json<SyncSourcesPage>("GET", this.path("/sources"))).sources;
  }

  /**
   * Adds a sync entry, as a team owner: a Slack workspace, GitHub
   * repositories or Linear teams, mapped to channels of this vibe. It acts
   * as a service, which must exist, and syncs where that service holds `read`,
   * `post` and `sync`. Vibe asks the platform who the credentials are, so
   * ones that don't work are refused.
   *
   * Point the platform's webhooks at the returned `webhook` path on this
   * Vibe's URL, signed with the `secret` given here.
   *
   * @param source.key Its name in the vibe, such as `slack`: what targets,
   *   `source` filters and a message's `from` say.
   * @param source.map Platform channel to vibe channel: `{ "#errors":
   *   "errors-www" }` for Slack, `{ "acme/www": "dev" }` or `{ "acme/api": {
   *   pulls: "prs", issues: "issues", replies: true } }` for GitHub, `{ ENG:
   *   "dev" }` for Linear.
   * @param source.credentials `token` is the platform's API token, and
   *   `secret` what it signs its webhooks with. Neither is ever returned.
   */
  async createSource(source: {
    key: string;
    platform: SyncPlatform;
    service: string;
    map?: Record<string, SyncMapInput> | undefined;
    credentials: { token?: string | undefined; secret: string };
    /** Where the platform's API is, when it isn't the usual place. */
    api?: string | undefined;
  }): Promise<SyncSource> {
    const path = this.path("/sources");
    return (await this.json<SyncSourceResponse>("POST", path, { json: source })).source;
  }

  /**
   * Replaces a sync entry's token, its webhook secret, or both, as a team
   * owner. What you don't give stays. Vibe asks the platform who the
   * credentials are again, so a token that doesn't work changes nothing.
   */
  async updateSourceCredentials(
    key: string,
    credentials: { token?: string | undefined; secret?: string | undefined },
  ): Promise<SyncSource> {
    const path = this.path(`/sources/${encodeURIComponent(key)}/credentials`);
    return (await this.json<SyncSourceResponse>("PUT", path, { json: credentials })).source;
  }

  /**
   * Removes a sync entry, as a team owner, with its credentials and its
   * records of what is synced where. What came in through it stays.
   */
  async deleteSource(key: string): Promise<SyncSource> {
    const path = this.path(`/sources/${encodeURIComponent(key)}`);
    return (await this.json<SyncSourceResponse>("DELETE", path)).source;
  }

  /**
   * The raw events a sync entry received from its platform, newest first,
   * each with what became of it. It takes `sync` in every channel.
   */
  async inbox(
    key: string,
    options: { limit?: number | undefined } = {},
  ): Promise<SyncInboxEntry[]> {
    const path = this.path(`/sources/${encodeURIComponent(key)}/inbox`);
    return (await this.json<SyncInboxPage>("GET", path, { query: { limit: options.limit } }))
      .events;
  }

  /**
   * Where a thread is synced, or with a target, syncs it there.
   *
   * `sync(id)` returns the platform threads that the message's thread syncs
   * with, each with the platform's link to the message's copy there, and the
   * deliveries that failed.
   *
   * `sync(id, target)` syncs the thread with a platform target, such as
   * `slack:#incidents`, `github:acme/www:123` or `linear:ENG-45`. A channel
   * starts a thread there and sends the thread's messages in order. A thread
   * joins one that exists, and receives what is written after. It takes
   * `sync` in the thread's channel.
   *
   * @throws `already_synced` when the platform thread syncs with another
   *   thread, and `no_sync` when the thread's root was posted with `noSync`.
   */
  sync(id: string): Promise<SyncedView>;
  sync(id: string, target: string): Promise<SyncThreadResponse>;
  sync(id: string, target?: string): Promise<SyncedView | SyncThreadResponse> {
    const path = this.path(`/threads/${encodeURIComponent(id)}/sync`);
    return target === undefined
      ? this.json("GET", path)
      : this.json("POST", path, { json: { target } });
  }

  /** The team's schemas for structured data, by name and then version. Every vibe of the team shares them. */
  async schemas(): Promise<Schema[]> {
    return (await this.json<SchemasPage>("GET", this.path("/schemas"))).schemas;
  }

  /** One schema, by its ID, such as `sandbox@1`. Fails with `schema_not_found`. */
  async schema(id: string): Promise<Schema> {
    const path = this.path(`/schemas/${encodeURIComponent(id)}`);
    return (await this.json<{ schema: Schema }>("GET", path)).schema;
  }

  /**
   * Registers a version of a schema: a JSON Schema for an object. Takes
   * `manage` at `*`. A version never changes: the same definition again
   * returns `created: false`, and a different one fails with
   * `schema_immutable`. To change a schema, register its next version.
   */
  createSchema(input: {
    name: string;
    version: number;
    description?: string | undefined;
    schema: Record<string, unknown>;
  }): Promise<CreateSchemaResponse> {
    return this.json("POST", this.path("/schemas"), { json: input });
  }

  /** Stores a file and returns its ID, to pass as an attachment on a post. */
  async upload(file: UploadFile): Promise<Attachment> {
    const bytes = await toBytes(file.data);
    const type = file.type ?? (file.data instanceof Blob && file.data.type ? file.data.type : null);
    const response = await this.send("POST", this.path("/attachments"), {
      query: { name: file.name },
      body: bytes,
      headers: {
        "content-type": type ?? "application/octet-stream",
        "content-length": String(bytes.byteLength),
      },
    });
    return (await response.json()) as Attachment;
  }

  /**
   * Where a file is read from, for a link on a page the Vibe itself serves:
   * the browser asks with its session, and gets the file as a download.
   */
  attachmentUrl(id: string): string {
    return `${this.url}${this.path(`/attachments/${encodeURIComponent(id)}`)}`;
  }

  /** Opens a file for reading. `response` carries the bytes. */
  async download(
    id: string,
  ): Promise<{ name: string; type: string; size: number; response: Response }> {
    const response = await this.send("GET", this.path(`/attachments/${encodeURIComponent(id)}`));
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(
      response.headers.get("content-disposition") ?? "",
    );
    return {
      name: encoded?.[1] ? decodeURIComponent(encoded[1]) : id,
      // What its uploader said it is. It is served as bytes unless it is a picture.
      type:
        response.headers.get("vibe-content-type") ??
        response.headers.get("content-type") ??
        "application/octet-stream",
      size: Number(response.headers.get("content-length") ?? 0),
      response,
    };
  }

  /**
   * One request for events after a cursor, waiting up to `wait` seconds for the
   * first. Pass the returned `cursor` back as `after` to continue.
   */
  poll(
    query: Filters & {
      after?: string | undefined;
      wait?: number | undefined;
      limit?: number | undefined;
      /** Include the events that only keep the books, such as a task's lease renewals. */
      all?: boolean | undefined;
    } = {},
    signal?: AbortSignal,
  ): Promise<EventsPage> {
    const { channel, by, re, after, wait, limit } = query;
    return this.json("GET", this.path("/events"), {
      query: {
        channel,
        by,
        re,
        after,
        wait,
        limit,
        mentions: query.mentions,
        source: query.source,
        label: labelFilters(query.label),
        all: query.all === true ? "true" : undefined,
      },
      signal,
    });
  }

  /**
   * Follows the vibe's events from `after`, or from now. Failed requests are
   * retried with a backoff; a refusal from Vibe throws. Abort the signal to stop.
   *
   * While the handle's live socket is open, each event arrives as soon as it
   * is written: Vibe says the log has moved, and the handle asks what is new.
   * Without the socket, each request waits up to 20 seconds for an event.
   */
  async *events(
    query: Filters & { after?: string | undefined; all?: boolean | undefined } = {},
    options: {
      signal?: AbortSignal | undefined;
      /**
       * Told when following goes well and when it doesn't: `live` once a
       * request for events has been answered, `retrying` when one failed and
       * is being tried again. For a page that says whether it is up to date.
       */
      onState?: ((state: "live" | "retrying") => void) | undefined;
    } = {},
  ): AsyncGenerator<VibeEvent> {
    const { signal, onState } = options;
    const live = this.live();
    let after = query.after;
    let backoff = 500;
    try {
      while (!signal?.aborted) {
        // Listening comes before asking: a poke that lands while the request
        // is out is kept, and the handle asks again at once.
        const listening = live !== null && (await live.ready(signal));
        live?.listen();
        let page: EventsPage;
        try {
          const wait = listening ? 0 : MAX_WAIT_SECONDS;
          page = await this.poll({ ...query, after, wait }, signal);
          backoff = 500;
          onState?.("live");
        } catch (error) {
          if (signal?.aborted) return;
          // Asked too often is not a refusal: it passes, and Vibe says when.
          // Following goes on from the same place once it has.
          const wait = askAgainIn(error);
          if (wait !== null) {
            onState?.("retrying");
            await new Promise((resolve) => setTimeout(resolve, wait * 1000));
            continue;
          }
          if (error instanceof VibeError && error.status >= 400 && error.status < 500) throw error;
          onState?.("retrying");
          await new Promise((resolve) => setTimeout(resolve, backoff));
          backoff = Math.min(backoff * 2, 30_000);
          continue;
        }
        after = page.cursor;
        yield* page.events;
        if (live !== null && listening && page.events.length === 0) {
          await live.heard(live.repollMs, signal);
        }
      }
    } finally {
      live?.close();
    }
  }

  /**
   * Returns the next matching event after `after`, or `null` when the timeout
   * passes. Pass your own message's ID as `after` so a reply that lands before
   * `wait` starts still counts.
   *
   * @param options.timeout A duration such as `30s` or `10m`, or milliseconds.
   *   Defaults to 30 minutes.
   */
  async wait(
    query: Filters & { after?: string | undefined } = {},
    options: { timeout?: string | number | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<VibeEvent | null> {
    const { signal } = options;
    const deadline = Date.now() + parseDuration(options.timeout ?? "30m");
    const live = this.live();
    let after = query.after;
    try {
      for (;;) {
        // With the socket open the handle asks without waiting, and sleeps
        // until Vibe says there is news. Without it, the request does the waiting.
        const listening = live !== null && deadline > Date.now() && (await live.ready(signal));
        live?.listen();
        const remaining = Math.max(0, deadline - Date.now());
        const wait = listening ? 0 : Math.min(MAX_WAIT_SECONDS, remaining / 1000);
        const page = await this.poll({ ...query, after, wait, limit: 1 }, signal);
        const [event] = page.events;
        if (event) return event;
        after = page.cursor;
        const left = deadline - Date.now();
        if (remaining === 0 || left <= 0) return null;
        if (live !== null && listening) await live.heard(Math.min(live.repollMs, left), signal);
      }
    } finally {
      live?.close();
    }
  }

  /** A listener on this vibe's live socket, for one `events` or `wait`. `null` when the handle long-polls. */
  private live(): Live | null {
    if (this.source === null) return null;
    return new Live(
      `${this.url.replace(/^http/, "ws")}${this.path("/live")}`,
      this.identity(),
      this.source,
    );
  }

  /** The headers that say who a request is from, and what it asks to be held to. */
  private identity(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    if (this.profile) headers["vibe-profile"] = this.profile;
    const [first, ...rest] = this.limits;
    if (first) headers["vibe-can"] = JSON.stringify(rest.length > 0 ? this.limits : first);
    return headers;
  }

  private async write(body: PostMessageRequest): Promise<Written> {
    const { message, unresolved } = await this.json<PostMessageResponse>(
      "POST",
      this.path("/messages"),
      { json: body },
    );
    return { ...message, unresolved };
  }

  private path(rest: string): string {
    return `/v1/vibes/${encodeURIComponent(this.name)}${rest}`;
  }

  private async json<T>(method: string, path: string, init: SendInit = {}): Promise<T> {
    return (await (await this.send(method, path, init)).json()) as T;
  }

  private async send(method: string, path: string, init: SendInit = {}): Promise<Response> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value === undefined) continue;
      if (typeof value === "string" || typeof value === "number") search.set(key, String(value));
      else for (const item of value) search.append(key, item);
    }
    const headers: Record<string, string> = { ...init.headers, ...this.identity() };
    if (init.json !== undefined) headers["content-type"] = "application/json";

    const request: RequestInit = { method, headers };
    if (init.json !== undefined) request.body = JSON.stringify(init.json);
    else if (init.body !== undefined) request.body = init.body;
    if (init.signal !== undefined) request.signal = init.signal;

    const query = search.size > 0 ? `?${search}` : "";
    const response = await this.fetcher(`${this.url}${path}${query}`, request);
    if (response.ok) return response;
    throw await failure(response);
  }
}

interface SendInit {
  query?: Query | undefined;
  json?: unknown;
  body?: Uint8Array<ArrayBuffer> | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
}

/** A span as the API takes it, in seconds. */
function seconds(span: string | number | undefined): number | undefined {
  return span === undefined ? undefined : parseDuration(span) / 1000;
}

/** A time as the API takes it. A string goes as it is, for Vibe to read or refuse. */
function instant(time: Date | string | undefined): string | undefined {
  if (time === undefined || typeof time === "string") return time;
  return Number.isNaN(time.getTime()) ? "invalid date" : time.toISOString();
}

function labelFilters(label: Filters["label"]): string[] | undefined {
  if (label === undefined) return undefined;
  if (typeof label === "string") return [label];
  if (Array.isArray(label)) return label;
  return Object.entries(label).map(([key, value]) => `${key}=${value}`);
}

async function toBytes(data: UploadFile["data"]): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return new Uint8Array(data);
}
