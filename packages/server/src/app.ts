import { createActivity, type Hub } from "@vibe/activity";
import {
  createAutomation,
  type DeliveryTrigger,
  scheduleNotFound,
  type Send,
  watcherNotFound,
} from "@vibe/automation";
import {
  type ActorsPage,
  AssignTaskRequest,
  BlockTaskRequest,
  type BrowserSession,
  type CancelScheduleResponse,
  CancelTaskRequest,
  type ChangeMessageResponse,
  type ChannelsPage,
  ClaimTaskRequest,
  type ClaimTaskResponse,
  CompleteTaskRequest,
  CreateChannelRequest,
  type CreateChannelResponse,
  CreateGrantRequest,
  CreateScheduleRequest,
  CreateSchemaRequest,
  type CreateSchemaResponse,
  CreateServiceRequest,
  type CreateServiceResponse,
  CreateSessionRequest,
  CreateSyncSourceRequest,
  CreateTasksRequest,
  type CreateTasksResponse,
  CreateTokenRequest,
  type CreateTokenResponse,
  CreateUserRequest,
  type CreateUserResponse,
  CreateWatcherRequest,
  type CreateWatcherResponse,
  DeleteMessageQuery,
  type DeviceLogin,
  type DeviceLoginResult,
  DeviceLoginTokenRequest,
  type DeviceSessionResult,
  EditMessageRequest,
  type EndSessionResponse,
  type ErrorBody,
  type EventsPage,
  EventsQuery,
  ExplainRequest,
  type Explanation,
  FailTaskRequest,
  type GrantResponse,
  type GrantsPage,
  type HeldToken,
  type HeldTokensPage,
  LabelsRequest,
  LinkGitHubRequest,
  type Message,
  PostMessageRequest,
  type PostMessageResponse,
  ReleaseTaskRequest,
  RenewTaskRequest,
  type RenewTaskResponse,
  type RevokeTokenResponse,
  type Schedule,
  type ScheduleResponse,
  type SchedulesPage,
  SchedulesQuery,
  type Schema,
  type SchemasPage,
  type Service,
  type ServiceResponse,
  type ServicesPage,
  ServiceTokenRequest,
  type ServiceTokenResponse,
  type SessionsPage,
  type SignInWays,
  type SyncedView,
  type SyncInboxPage,
  SyncInboxQuery,
  type SyncSource,
  type SyncSourceResponse,
  type SyncSourcesPage,
  SyncThreadRequest,
  type SyncThreadResponse,
  type TaskDetail,
  TaskNeedsRequest,
  type TasksPage,
  TasksQuery,
  type ThreadDetail,
  type ThreadsPage,
  ThreadsQuery,
  UpdateGrantRequest,
  UpdateSyncCredentialsRequest,
  UploadQuery,
  type VibesPage,
  type WatcherResponse,
  type WatchersPage,
  type Whoami,
} from "@vibe/contracts";
import {
  addressKey,
  type Caller,
  createIdentity,
  OPERATOR_SECRET,
  REFUSED_CREDENTIALS,
  REFUSED_WEBHOOKS,
  type Service as StoredService,
  SIGN_IN_ASKS,
  SIGN_INS_STARTED,
  type TokenView,
  type User,
} from "@vibe/identity";
import {
  ALL_CHANNELS,
  type BlobStore,
  type ChannelScope,
  type Clock,
  DomainError,
  type ErrorKind,
  forbidden,
  invalid,
  type LabelFilter,
  notFound,
  parseChannelPattern,
  parseLabelFilters,
  principalId,
  type Sleep,
  systemClock,
  tooLarge,
} from "@vibe/kernel";
import {
  createMessaging,
  type Schema as StoredSchema,
  schemaId,
  type VibeRecord,
} from "@vibe/messaging";
import { beginUnitOfWork, type Db } from "@vibe/store";
import { alreadySynced, createSync } from "@vibe/sync";
import { createTasks, OPEN_STATES, taskNotFound } from "@vibe/tasks";
import { Elysia, type ElysiaAdapter } from "elysia";

import { textUpTo } from "./bounded-body.ts";
import {
  clearedSessionCookie,
  isRead,
  requireSameOrigin,
  sessionCookie,
  sessionOf,
} from "./session-cookie.ts";

/**
 * Where live clients listen, on a runtime that can hold sockets open. The app
 * pokes it after each commit and hands it the sockets, and knows nothing of
 * how it keeps them.
 */
export interface LiveHub extends Hub {
  /** Answers a WebSocket upgrade with a socket that hears a vibe's pokes. */
  connect(vibeId: string, request: Request): Promise<Response>;
}

export interface AppOptions {
  db: Db;
  blobs: BlobStore;
  /** Leave it out where nothing holds sockets, as under Bun: clients then long-poll. */
  hub?: LiveHub | undefined;
  /** The runtime Elysia serves on. Leave it out under Bun; a Worker passes Cloudflare's. */
  adapter?: ElysiaAdapter | undefined;
  /**
   * The operator's secret for `/v1/admin`. Without one, those routes refuse
   * everyone. The key that sync entries' platform credentials are sealed
   * under is derived from it too, so without one nothing syncs.
   */
  adminSecret?: string | undefined;
  /**
   * What runs a pass over a vibe's watchers later: a queue on a Worker, a
   * timer under Bun. Leave it out and deliveries go out when `deliverWatchers`
   * is called, by the scheduler or by a test.
   */
  deliveries?: DeliveryTrigger | undefined;
  /**
   * Keeps the runtime going until work started on the way out of a request
   * has finished. A Worker passes `waitUntil`. Under Bun nothing is needed.
   */
  background?: ((work: Promise<unknown>) => void) | undefined;
  /** How Vibe reaches other servers: a watcher's endpoint, GitHub, Slack and Linear. `fetch`, when left out. */
  fetch?: Send | undefined;
  /**
   * The GitHub OAuth app people sign in through, by its client ID. Leave it
   * out and `vibe login` takes a token, as before.
   */
  github?:
    | {
        clientId: string;
        /** Let a GitHub account that is no one's here join as a new member. Off, unless said. */
        allowSignup?: boolean | undefined;
      }
    | undefined;
  /**
   * The network address a request came from, as the runtime knows it: what
   * the limits on guessing a credential are counted against. It must be
   * something the sender can't choose, such as the address Cloudflare saw, or
   * the socket's. Leave it out, or answer `null`, and those limits are off:
   * with no one to count against, one caller would use up everyone's.
   */
  clientAddress?: ((request: Request) => string | null | undefined) | undefined;
  clock?: Clock | undefined;
  sleep?: Sleep | undefined;
  pollIntervalMs?: number | undefined;
}

const STATUS: Record<ErrorKind, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  length_required: 411,
  too_large: 413,
  rate_limited: 429,
  unavailable: 502,
};

/**
 * The HTTP API, and the composition root: the one place that knows every
 * context and wires them together. It knows nothing of Cloudflare, so the same
 * app runs on a Worker with D1 and R2, and in a test with SQLite and memory.
 */
export function createApp(options: AppOptions) {
  return createVibe(options).app;
}

/**
 * The app, and the work that isn't a request: `fireSchedules` and `sweep` are
 * what the scheduler runs each minute.
 */
export function createVibe(options: AppOptions) {
  const { db, blobs, clock } = options;
  const begin = beginUnitOfWork(db);
  const identity = createIdentity({
    db,
    begin,
    clock,
    github: options.github && { ...options.github, fetch: options.fetch },
  });
  const background =
    options.background ??
    ((work: Promise<unknown>) => {
      work.catch((error: unknown) => console.error("Work after a request failed.", error));
    });

  // What hears that a vibe's log has moved: the live sockets, the vibe's
  // watchers, and its sync entries. The last two are wired in below, once
  // there is something to wire.
  let noticed: (vibeId: string) => Promise<void> = async () => {};
  const listeners: Hub = {
    poke(vibeId, seq) {
      options.hub?.poke(vibeId, seq);
      if (options.deliveries) background(noticed(vibeId));
    },
  };
  const activity = createActivity({
    db,
    hub: options.hub || options.deliveries ? listeners : undefined,
    clock,
    sleep: options.sleep,
    pollIntervalMs: options.pollIntervalMs,
  });
  const messaging = createMessaging({
    db,
    begin,
    blobs,
    eventLog: activity.eventLog,
    authorizer: identity.authorizer,
    actors: identity.actors,
    grants: identity.grants,
    clock,
  });
  const tasks = createTasks({
    db,
    begin,
    eventLog: activity.eventLog,
    authorizer: identity.authorizer,
    actors: identity.actors,
    messaging,
    clock,
    sleep: options.sleep,
    pollIntervalMs: options.pollIntervalMs,
  });
  const automation = createAutomation({
    db,
    begin,
    authorizer: identity.authorizer,
    actors: identity.actors,
    callers: identity.service,
    messaging,
    events: activity.service,
    send: options.fetch,
    deliveries: options.deliveries,
    clock,
  });
  const sync = createSync({
    db,
    begin,
    eventLog: activity.eventLog,
    authorizer: identity.authorizer,
    callers: identity.service,
    services: {
      // A sync entry names the service it acts as, and holds its principal.
      async principalOf(caller, name) {
        const wanted = name.trim().toLowerCase();
        const found = (await identity.services.list(caller)).find((each) => each.name === wanted);
        return found ? principalId("service", found.id) : null;
      },
    },
    messaging,
    events: activity.service,
    secret: options.adminSecret,
    send: options.fetch,
    deliveries: options.deliveries,
    clock,
  });
  noticed = async (vibeId) => {
    await Promise.all([automation.watchers.noticed(vibeId), sync.deliveries.noticed(vibeId)]);
  };
  const now = () => (clock ?? systemClock).now();

  /** One pass over a vibe's watchers and sync entries. What a queue or a timer runs after a write. */
  async function deliverVibe(vibeId: string) {
    const [watchers, synced] = await Promise.allSettled([
      automation.watchers.deliverVibe(vibeId),
      sync.deliveries.deliverVibe(vibeId),
    ]);
    for (const part of [watchers, synced]) {
      if (part.status === "rejected") console.error("A delivery pass failed.", part.reason);
    }
    return {
      watchers: watchers.status === "fulfilled" ? watchers.value : null,
      sync: synced.status === "fulfilled" ? synced.value : null,
    };
  }

  /** One pass of everything the scheduler does each minute. Each part runs whatever became of the others. */
  async function tick() {
    const [schedules, sweep, deliveries, synced, cleared] = await Promise.allSettled([
      automation.schedules.fireDue(),
      tasks.sweep.run(),
      automation.watchers.deliverDue(),
      sync.deliveries.deliverDue(),
      // Sessions that are over, tokens long expired, counts of attempts gone by.
      identity.upkeep.run(),
    ]);
    for (const part of [schedules, sweep, deliveries, synced, cleared]) {
      if (part.status === "rejected") console.error("A scheduled pass failed.", part.reason);
    }
    return {
      schedules: schedules.status === "fulfilled" ? schedules.value : null,
      sweep: sweep.status === "fulfilled" ? sweep.value : null,
      deliveries: deliveries.status === "fulfilled" ? deliveries.value : null,
      sync: synced.status === "fulfilled" ? synced.value : null,
      cleared: cleared.status === "fulfilled" ? cleared.value : null,
    };
  }

  /**
   * Who a request's attempts are counted against: the address it came from,
   * as one key for a whole IPv6 network. `null` where the runtime doesn't say.
   */
  function from(request: Request): string | null {
    const address = options.clientAddress?.(request)?.trim();
    return address ? addressKey(address) : null;
  }

  /**
   * Checks a credential someone showed, unless too many from their address
   * were refused already, and counts this one when it is refused too.
   *
   * @param together Ask whether the address is over while the credential is
   *   being checked, and not before, so a request waits for one answer and
   *   not two. Only for a check that changes nothing: its answer is thrown
   *   away when the address turns out to be over.
   */
  async function guarded<Recognised>(
    request: Request,
    check: () => Promise<Recognised>,
    together = false,
  ): Promise<Recognised> {
    const who = from(request);
    const admitted = identity.attempts.require(REFUSED_CREDENTIALS, who);
    if (!together) await admitted;
    const [admission, checked] = await Promise.allSettled([admitted, check()]);
    if (admission.status === "rejected") throw admission.reason;
    if (checked.status === "fulfilled") return checked.value;
    // Only a credential nobody has counts. A refusal for another reason,
    // such as a profile the token is not for, is not a guess.
    const refusal: unknown = checked.reason;
    if (refusal instanceof DomainError && refusal.kind === "unauthorized") {
      await identity.attempts.failed(REFUSED_CREDENTIALS, who);
    }
    throw refusal;
  }

  /**
   * The responses that switch a request to a WebSocket, set aside by the route
   * that made them for `fetch` below to return. Elysia builds a response of
   * its own from whatever a handler returns, and one that switches protocols
   * can't be rebuilt: its status is outside what a Response can be constructed
   * with, and its socket would not come along.
   */
  const upgrades = new WeakMap<Request, Response>();

  /**
   * A schedule as it stands, for a caller who can read its channel, and for
   * whoever made it. To anyone else it isn't there.
   */
  async function scheduleView(caller: Caller, vibe: VibeRecord, id: string): Promise<Schedule> {
    const schedule = await automation.queries.get(vibe.id, id);
    if (!schedule) throw scheduleNotFound(id);
    if (schedule.by.principal === caller.principal && caller.narrowed === null) return schedule;
    const scope = await identity.authorizer.scope(caller, vibe.id);
    if (!scope.allows(schedule.channel)) throw scheduleNotFound(id);
    return schedule;
  }

  /** A task as it stands, for a caller who can read its channel. To anyone else it isn't there. */
  async function taskDetail(caller: Caller, vibe: VibeRecord, id: string): Promise<TaskDetail> {
    const detail = await tasks.queries.get(vibe.id, id, now());
    if (!detail) throw taskNotFound(id);
    const scope = await identity.authorizer.scope(caller, vibe.id);
    if (!scope.allows(detail.task.channel)) throw taskNotFound(id);
    return detail;
  }

  /**
   * The message a change just touched, as the change left it. `null` for a
   * caller who can't read its channel: holding `label` or `react` there lets
   * you make the change, not see what it was made to.
   */
  async function messageAfter(caller: Caller, vibe: VibeRecord, id: string) {
    const message = await messaging.queries.getMessage(vibe.id, id);
    if (!message) throw messageNotFound(id);
    const scope = await identity.authorizer.scope(caller, vibe.id);
    return scope.allows(message.channel) ? message : null;
  }

  /**
   * A message its author gets back when a retry repeats a post. Whoever posts
   * with `post` alone must still get their post back, but not what others put
   * on it since: to a caller who can't read the channel, it comes back as it
   * was written, without the labels and reactions it has now.
   */
  async function asWritten(caller: Caller, vibe: VibeRecord, message: Message): Promise<Message> {
    const scope = await identity.authorizer.scope(caller, vibe.id);
    return scope.allows(message.channel) ? message : { ...message, labels: {}, reactions: [] };
  }

  /**
   * The tasks of a plan, for whoever made it. Making a task takes `post`, not
   * `read`, and a plan sent again with its key answers with the tasks it made
   * the first time. So whoever can read a task's channel is shown the task as
   * it stands, and whoever can't, or no longer can, gets it as they made it:
   * nothing of what others have done to it since.
   */
  async function tasksAsWritten(
    caller: Caller,
    vibe: VibeRecord,
    details: TaskDetail[],
  ): Promise<TaskDetail[]> {
    const scope = await identity.authorizer.scope(caller, vibe.id);
    return details.map((detail) =>
      scope.allows(detail.task.channel)
        ? detail
        : {
            task: {
              ...detail.task,
              state: detail.task.needs.length > 0 ? "waiting" : "ready",
              claimedBy: null,
              leaseExpiresAt: null,
              hold: null,
              result: null,
              reason: null,
              updatedAt: detail.task.createdAt,
            },
            message: { ...detail.message, labels: {}, reactions: [] },
          },
    );
  }

  /**
   * Who a request is from: whoever its token belongs to, or failing a token,
   * the person whose session its cookie carries.
   *
   * A request that rides on a cookie is checked for where it came from when
   * it changes something, or opens a socket: a browser sends the cookie with
   * whatever a page asks of this origin, so the cookie alone doesn't show the
   * person meant it. Reads are let through, since another site's page can
   * cause one and can't see its answer.
   */
  async function recognise(
    request: Request,
    token: string | null,
    profile: string | undefined,
    limits: string | undefined,
  ): Promise<Caller> {
    const secret = token === null ? sessionOf(request) : null;
    // Nothing was shown, so nothing was guessed: refused, and not counted.
    if (token === null && secret === null) return identity.service.authenticate(null);
    return guarded(
      request,
      async () => {
        const person = secret === null ? null : await identity.sessions.authenticate(secret);
        if (!person) return identity.service.authenticate(token, profile, limits);
        const opensSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
        if (!isRead(request) || opensSocket) requireSameOrigin(request);
        return identity.service.acting(person, profile, limits);
      },
      true,
    );
  }

  /** A principal's tokens as the API shows them, each delegated one with the name of its vibe. */
  async function heldTokens(teamId: string | null, tokens: TokenView[]): Promise<HeldToken[]> {
    const named = new Map<string, string>();
    if (teamId !== null && tokens.some((token) => token.delegated !== null)) {
      for (const vibe of await messaging.vibes.list(teamId)) named.set(vibe.id, vibe.name);
    }
    return tokens.map((token) => heldToken(token, named));
  }

  /** Who a `mentions` filter names, as an actor ID. `me`, or nothing at all, is the caller. */
  async function mentioned(
    named: string | undefined,
    caller: Caller,
    vibe: VibeRecord,
  ): Promise<string | undefined> {
    if (named === undefined) return undefined;
    if (named === "" || named === "me") return caller.actorId;
    return messaging.actors.idOf(vibe, named);
  }

  const app =
    // Without an adapter this is Elysia on Bun, compiled ahead of time. With one,
    // routes are matched dynamically: ahead-of-time compilation generates code
    // from strings, which the Workers runtime refuses outside of startup, and the
    // Vite dev runner loads this module after startup.
    new Elysia(options.adapter ? { adapter: options.adapter, aot: false } : {})
      .onError(({ code, error, set, request }): ErrorBody => {
        if (error instanceof DomainError) {
          set.status = STATUS[error.kind];
          // A failure that passes by itself says when, in whole seconds, rounded up.
          if (error.retryAfterMs !== undefined) {
            set.headers["retry-after"] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
          }
          return error.hint === undefined
            ? { code: error.code, message: error.message }
            : { code: error.code, message: error.message, hint: error.hint };
        }
        if (code === "VALIDATION") {
          set.status = 400;
          return { code: "invalid_request", message: describe(error.all[0]) };
        }
        if (code === "PARSE") {
          set.status = 400;
          return { code: "invalid_request", message: "The request body could not be read." };
        }
        if (code === "NOT_FOUND") {
          set.status = 404;
          const { pathname } = new URL(request.url);
          return { code: "not_found", message: `There is no ${request.method} ${pathname}.` };
        }
        console.error(error);
        set.status = 500;
        return { code: "internal", message: "Something went wrong on our side." };
      })

      // Where the web app is served too, `/` is the app, and the API says what it is at `/v1`.
      .get("/", () => ({ name: "vibe", api: "v1" }))
      .get("/v1", () => ({ name: "vibe", api: "v1" }))

      // ── Operator routes ────────────────────────────────────────────────────
      // Until there is a sign-in flow, an operator holding the deployment's
      // secret adds people and hands them their tokens.
      .group("/v1/admin", (admin) =>
        admin
          .onBeforeHandle(async ({ headers, request }) => {
            const given = bearer(headers["authorization"]);
            const refused = () =>
              forbidden(
                "forbidden",
                "These routes are for the deployment's operator.",
                "Send the deployment's VIBE_ADMIN_SECRET as the bearer token.",
              );
            if (!options.adminSecret || !given) throw refused();
            // The one secret here that a person chose. A try at it is counted
            // before it is compared, so tries made at once can't all be
            // compared, and taken back when it was right.
            const taken = await identity.attempts.take(OPERATOR_SECRET, from(request));
            if (!sameSecret(given, options.adminSecret)) throw refused();
            await identity.attempts.giveBack(taken);
          })
          .post(
            "/users",
            async ({ body, set }): Promise<CreateUserResponse> => {
              const { user, token } = await identity.service.createUser(body);
              set.status = 201;
              return { user: personView(user), token };
            },
            { body: CreateUserRequest },
          )
          // Says which GitHub account a person signs in with, from their next sign-in.
          .put(
            "/users/:handle/github",
            async ({ params, body }) => {
              const user = await identity.service.linkGitHub({
                handle: params.handle,
                github: body.github,
              });
              return { user: personView(user), github: user.githubLogin };
            },
            { body: LinkGitHubRequest },
          )
          .post("/users/:handle/tokens", async ({ params, set }) => {
            const token = await identity.service.mintToken({ handle: params.handle });
            set.status = 201;
            return { token };
          })
          // A person's tokens, and revoking one: for a token that was lost
          // with the only machine that could have revoked it.
          .get("/users/:handle/tokens", async ({ params }): Promise<HeldTokensPage> => ({
            tokens: await heldTokens(null, await identity.tokens.ofUser(params.handle)),
          }))
          .delete(
            "/users/:handle/tokens/:id",
            async ({ params }): Promise<RevokeTokenResponse> => ({
              token: heldToken(await identity.tokens.revokeOfUser(params.handle, params.id)),
            }),
          )
          // One pass of what the scheduler runs each minute, now: due
          // schedules, the task sweep, and watchers' deliveries. For an
          // operator who won't wait a minute, and for a Vibe with no scheduler.
          .post("/tick", () => tick()),
      )

      // ── Signing in ─────────────────────────────────────────────────────────
      // GitHub's device flow, for a person at a terminal: the device shows a
      // code, they approve it in a browser, and Vibe issues a token of its
      // own for whoever that GitHub account belongs to here. These two routes
      // take no token, since their caller has none yet.
      .group("/v1/login", (login) =>
        login
          // Each start, and each ask after one, is a request Vibe makes of
          // GitHub on the app's own allowance. So both are counted against
          // the address that asks, whatever comes of them.
          .post("/device", async ({ request }): Promise<DeviceLogin> => {
            if (identity.signIn.available) {
              await identity.attempts.take(SIGN_INS_STARTED, from(request));
            }
            return identity.signIn.start();
          })
          .post(
            "/device/token",
            async ({ body, request }): Promise<DeviceLoginResult> => {
              if (identity.signIn.available) {
                await identity.attempts.take(SIGN_IN_ASKS, from(request));
              }
              const result = await identity.signIn.finish(body.deviceCode);
              if (result.status === "pending") return result;
              return {
                status: "complete",
                token: result.token,
                user: personView(result.user),
                created: result.created,
              };
            },
            { body: DeviceLoginTokenRequest },
          ),
      )

      // ── Signing in from a browser ──────────────────────────────────────────
      // A browser has nowhere safe to keep a token: whatever a page's scripts
      // can read, a script that shouldn't be on the page can read too. So a
      // person who signs in from a browser gets a session, whose secret is in
      // a cookie that scripts can't read, and the page holds nothing.
      .get("/v1/login", (): SignInWays => ({ github: identity.signIn.available }))
      .group("/v1/session", (session) =>
        session
          // These change who the browser is signed in as. A page of another
          // site must not be able to cause that.
          .onBeforeHandle(({ request }) => {
            if (request.headers.get("origin") !== null) requireSameOrigin(request);
          })
          .post(
            "",
            async ({ body, request, set }): Promise<BrowserSession> => {
              // A token nobody has is a guess, here as anywhere.
              const opened = await guarded(request, () =>
                identity.sessions.openWithToken(body.token, request.headers.get("user-agent")),
              );
              const { caller } = opened;
              set.status = 201;
              set.headers["set-cookie"] = sessionCookie(
                request,
                opened.secret,
                opened.expiresAt - now(),
              );
              set.headers["cache-control"] = "no-store";
              return {
                user: {
                  id: caller.principal.slice(caller.principal.lastIndexOf(":") + 1),
                  handle: caller.handle,
                  name: caller.name,
                  role: caller.role === "service" ? "member" : caller.role,
                },
                expiresAt: new Date(opened.expiresAt).toISOString(),
              };
            },
            { body: CreateSessionRequest },
          )
          // GitHub's device flow, finished into a session: no token is minted.
          .post(
            "/device",
            async ({ body, request, set }): Promise<DeviceSessionResult> => {
              if (identity.signIn.available) {
                await identity.attempts.take(SIGN_IN_ASKS, from(request));
              }
              const result = await identity.signIn.finishInBrowser(
                body.deviceCode,
                identity.sessions,
                request.headers.get("user-agent"),
              );
              if (result.status === "pending") return result;
              set.headers["set-cookie"] = sessionCookie(
                request,
                result.session.secret,
                result.session.expiresAt - now(),
              );
              set.headers["cache-control"] = "no-store";
              return {
                status: "complete",
                user: personView(result.user),
                expiresAt: new Date(result.session.expiresAt).toISOString(),
                created: result.created,
              };
            },
            { body: DeviceLoginTokenRequest },
          )
          .delete("", async ({ request, set }) => {
            const secret = sessionOf(request);
            if (secret !== null) await identity.sessions.close(secret);
            set.headers["set-cookie"] = clearedSessionCookie(request);
            return { signedOut: true };
          }),
      )

      // ── What the platforms send ────────────────────────────────────────────
      // A sync entry's webhooks. They carry no token of ours: each is checked
      // against the signature its platform puts on it, with the entry's own
      // secret, over the body exactly as it arrived. So the body is read
      // here, as text, and parsed only once it is known to be the platform's.
      .post(
        "/v1/sync/webhooks/:source",
        async ({ params, request }) => {
          // What bounds guessing at the secret a platform signs with, which a
          // person may have chosen. Refusals are counted against an address
          // for each entry apart: a platform sends every entry's events from
          // the same few addresses, and one entry with the wrong secret must
          // not shut out the others. A webhook for no entry at all is not
          // counted: an ID is 80 random bits, and an entry that was removed
          // goes on being sent events that are nobody's guess.
          const who = from(request);
          const sender = who === null ? null : `${who} ${params.source.slice(0, 64)}`;
          await identity.attempts.require(REFUSED_WEBHOOKS, sender);

          // A sender may leave out the length and send without end, so the
          // limit is kept while reading, not checked afterwards.
          const body = await textUpTo(request, MAX_WEBHOOK_BYTES, webhookTooLarge);
          const answer = await sync.receive
            .webhook(params.source, { headers: request.headers, body })
            .catch(async (error: unknown) => {
              if (error instanceof DomainError && error.code === "webhook_refused") {
                await identity.attempts.failed(REFUSED_WEBHOOKS, sender);
              }
              throw error;
            });
          return new Response(answer.body, {
            status: answer.status,
            headers: { "content-type": answer.contentType },
          });
        },
        // As for uploads: a parser that claims every content type and reads nothing.
        { parse: () => UNREAD },
      )

      // ── Everything else needs a token ──────────────────────────────────────
      .group("/v1", (v1) =>
        v1
          .resolve(async ({ headers, request }) => ({
            caller: await recognise(
              request,
              bearer(headers["authorization"]),
              // An agent names itself. The name changes who a write is
              // attributed to, never what the token may do.
              headers["vibe-profile"],
              // A request may ask to be held to less than its token allows.
              headers["vibe-can"],
            ),
          }))

          .get("/whoami", ({ caller }): Whoami => whoami(caller))

          .get("/vibes", async ({ caller }): Promise<VibesPage> => {
            // Asking for the default vibe creates it, so a new team's list is never empty.
            await messaging.vibes.resolve(caller.teamId);
            const vibes = await messaging.vibes.list(caller.teamId);
            // A token minted for one vibe is shown that vibe, and no other.
            const only = caller.narrowed?.vibeId ?? null;
            return {
              vibes: vibes
                .filter((vibe) => only === null || vibe.id === only)
                .map((vibe) => ({
                  id: vibe.id,
                  name: vibe.name,
                  createdAt: new Date(vibe.createdAt).toISOString(),
                })),
            };
          })

          // ── Services ───────────────────────────────────────────────────────
          // Machine principals, for CI jobs and workers. They belong to the
          // team, not to one vibe: each vibe's grants say what they can do there.

          .get("/services", async ({ caller }): Promise<ServicesPage> => ({
            services: (await identity.services.list(caller)).map(serviceView),
          }))

          .post(
            "/services",
            async ({ caller, body, set }): Promise<CreateServiceResponse> => {
              const { service, token } = await identity.services.create(caller, body);
              set.status = 201;
              return { service: serviceView(service), token };
            },
            { body: CreateServiceRequest },
          )

          .post(
            "/services/:name/tokens",
            async ({ caller, params, body, set }): Promise<ServiceTokenResponse> => {
              const token = await identity.services.mintToken(caller, params.name, body.label);
              set.status = 201;
              return { token };
            },
            { body: ServiceTokenRequest },
          )

          .delete("/services/:name", async ({ caller, params }): Promise<ServiceResponse> => ({
            service: serviceView(await identity.services.remove(caller, params.name)),
          }))

          .get("/services/:name/tokens", async ({ caller, params }): Promise<HeldTokensPage> => ({
            tokens: await heldTokens(
              caller.teamId,
              await identity.tokens.ofService(caller, params.name),
            ),
          }))

          .delete(
            "/services/:name/tokens/:id",
            async ({ caller, params }): Promise<RevokeTokenResponse> => {
              const revoked = await identity.tokens.revokeOfService(caller, params.name, params.id);
              return {
                token: (await heldTokens(caller.teamId, [revoked]))[0] ?? heldToken(revoked),
              };
            },
          )

          // ── Your own tokens and sessions ───────────────────────────────────
          // What lets you in, listed without its secrets, and a way to end
          // each: a token that leaked, a browser you no longer have.

          .get("/tokens", async ({ caller }): Promise<HeldTokensPage> => ({
            tokens: await heldTokens(caller.teamId, await identity.tokens.mine(caller)),
          }))

          .delete("/tokens/:id", async ({ caller, params }): Promise<RevokeTokenResponse> => {
            const revoked = await identity.tokens.revokeMine(caller, params.id);
            return { token: (await heldTokens(caller.teamId, [revoked]))[0] ?? heldToken(revoked) };
          })

          .get("/sessions", async ({ caller }): Promise<SessionsPage> => ({
            sessions: (await identity.sessions.list(caller)).map((session) => ({
              id: session.id,
              createdAt: new Date(session.createdAt).toISOString(),
              expiresAt: new Date(session.expiresAt).toISOString(),
              userAgent: session.userAgent,
              openedWith: session.openedWith,
              current: session.current,
            })),
          }))

          .delete("/sessions/:id", async ({ caller, params }): Promise<EndSessionResponse> => {
            await identity.sessions.end(caller, params.id);
            return { ended: true, id: params.id };
          })

          .group("/vibes/:vibe", (scoped) =>
            scoped
              .resolve(async ({ caller, params }) => ({
                vibe: await messaging.vibes.resolve(caller.teamId, params.vibe),
              }))

              .get("/whoami", async ({ caller, vibe }): Promise<Whoami> => ({
                ...whoami(caller),
                vibe: { id: vibe.id, name: vibe.name },
                can: await identity.grants.mine(caller, vibe.id),
              }))

              // Reads return what the caller can read, and say nothing of the
              // rest: a channel closed to them isn't listed, and a message in
              // one is, to them, not found.
              .get("/channels", async ({ caller, vibe }): Promise<ChannelsPage> => {
                const scope = await identity.authorizer.scope(caller, vibe.id);
                const channels = await messaging.queries.listChannels(vibe.id);
                return { channels: channels.filter((channel) => scope.allows(channel.path)) };
              })

              .post(
                "/channels",
                async ({ caller, vibe, body, set }): Promise<CreateChannelResponse> => {
                  const result = await messaging.channels.create({
                    caller,
                    vibe,
                    path: body.path,
                    private: body.private,
                  });
                  set.status = result.created ? 201 : 200;
                  return result;
                },
                { body: CreateChannelRequest },
              )

              .get("/actors", async ({ caller, vibe }): Promise<ActorsPage> => ({
                actors: await messaging.actors.list(caller, vibe),
              }))

              .get(
                "/threads",
                async ({ caller, vibe, query, request }): Promise<ThreadsPage> => {
                  const scope = await identity.authorizer.scope(caller, vibe.id);
                  // The cursor is read before the threads. Anything that lands in
                  // between shows up in this list and again after the cursor:
                  // seen twice, never missed.
                  const cursor = await activity.service.head(vibe.id);
                  const threads = await messaging.queries.listThreads(
                    vibe.id,
                    {
                      channel: parseChannelPattern(query.channel),
                      by: actorFilter(query.by, caller),
                      labels: labelFilters(request),
                      mentions: await mentioned(query.mentions, caller, vibe),
                      source: sourceFilter(query.source),
                      afterSeq:
                        query.after === undefined
                          ? undefined
                          : await activity.service.resolve(vibe.id, query.after, async () => scope),
                      limit: query.limit,
                    },
                    scope,
                  );
                  return { threads, cursor };
                },
                { query: ThreadsQuery },
              )

              .get("/threads/:id", async ({ caller, vibe, params }): Promise<ThreadDetail> => {
                const cursor = await activity.service.head(vibe.id);
                const thread = await messaging.queries.getThread(vibe.id, params.id);
                if (!thread) throw messageNotFound(params.id);
                const scope = await identity.authorizer.scope(caller, vibe.id);
                if (!scope.allows(thread.message.channel)) throw messageNotFound(params.id);
                const task = await tasks.queries.get(vibe.id, thread.message.id, now());
                const pending = await automation.queries.list(
                  vibe.id,
                  { channel: ALL_CHANNELS, threadId: thread.message.id, limit: 100 },
                  scope,
                  caller,
                );
                return {
                  ...thread,
                  task: task?.task ?? null,
                  schedules: pending,
                  // Whoever reads a thread is told where its words go.
                  sync: await sync.queries.synced(vibe.id, thread.message.id, thread.message.id),
                  cursor,
                };
              })

              .get("/grants", async ({ caller, vibe }): Promise<GrantsPage> => ({
                grants: await identity.grants.list(caller, vibe.id),
              }))

              .post(
                "/grants",
                async ({ caller, vibe, body, set }): Promise<GrantResponse> => {
                  const grant = await identity.grants.create(caller, vibe.id, body);
                  set.status = 201;
                  return { grant };
                },
                { body: CreateGrantRequest },
              )

              .post(
                "/grants/explain",
                ({ caller, vibe, body }): Promise<Explanation> =>
                  identity.grants.explain(caller, vibe.id, body.channel, body),
                { body: ExplainRequest },
              )

              .patch(
                "/grants/:id",
                async ({ caller, vibe, params, body }): Promise<GrantResponse> => ({
                  grant: await identity.grants.update(caller, vibe.id, params.id, body),
                }),
                { body: UpdateGrantRequest },
              )

              .delete("/grants/:id", async ({ caller, vibe, params }): Promise<GrantResponse> => ({
                grant: await identity.grants.revoke(caller, vibe.id, params.id),
              }))

              // A token that passes on part of the caller's access: for this
              // vibe, as one profile, for a while.
              .post(
                "/tokens",
                async ({ caller, vibe, body, set }): Promise<CreateTokenResponse> => {
                  const minted = await identity.delegation.mint(caller, vibe.id, {
                    profile: body.profile,
                    can: body.can,
                    ttlMs: milliseconds(body.ttl),
                  });
                  set.status = 201;
                  return {
                    id: minted.id,
                    token: minted.token,
                    profile: minted.profile,
                    can: Object.fromEntries(
                      Object.entries(minted.can).map(([pattern, list]) => [pattern, [...list]]),
                    ),
                    expiresAt: new Date(minted.expiresAt).toISOString(),
                  };
                },
                { body: CreateTokenRequest },
              )

              // ── Watchers ─────────────────────────────────────────────────
              // URLs that the vibe's matching events are posted to. A watcher
              // carries what its registrant can read out of the vibe, so
              // registering one, and seeing them, takes `manage` at `*`.

              .get("/watchers", async ({ caller, vibe }): Promise<WatchersPage> => {
                await automation.watchers.requireList(caller, vibe);
                return { watchers: await automation.watcherQueries.list(vibe.id) };
              })

              .post(
                "/watchers",
                async ({ caller, vibe, body, set }): Promise<CreateWatcherResponse> => {
                  const { id, secret } = await automation.watchers.register({
                    caller,
                    vibe,
                    name: body.name,
                    url: body.url,
                    tail: {
                      channel: body.channel,
                      re: body.re,
                      by: actorFilter(body.by, caller),
                      labels: body.labels,
                      mentions: await mentioned(body.mentions, caller, vibe),
                      source: body.source,
                      all: body.all,
                    },
                  });
                  const watcher = await automation.watcherQueries.get(vibe.id, id);
                  if (!watcher) throw watcherNotFound(id);
                  set.status = 201;
                  return { watcher, secret };
                },
                { body: CreateWatcherRequest },
              )

              .delete(
                "/watchers/:id",
                async ({ caller, vibe, params }): Promise<WatcherResponse> => {
                  // Read before it goes, to show what was deleted.
                  const found = await automation.watcherQueries.list(vibe.id);
                  const { id } = await automation.watchers.remove({ caller, vibe, id: params.id });
                  const watcher = found.find((each) => each.id === id);
                  if (!watcher) throw watcherNotFound(params.id);
                  return { watcher };
                },
              )

              // ── Sync ─────────────────────────────────────────────────────
              // Sync entries: platform accounts whose channels sync with this
              // vibe's. Anyone who reads here may see them, to check where
              // their words can go. Only a team owner adds or removes one.

              .get("/sources", async ({ caller, vibe }): Promise<SyncSourcesPage> => {
                await sync.sources.requireList(caller, vibe);
                const scope = await identity.authorizer.scope(caller, vibe.id);
                const sources = await sync.queries.sources(vibe.id);
                return { sources: sources.map((source) => visibleTo(scope, source)) };
              })

              .post(
                "/sources",
                async ({ caller, vibe, body, set }): Promise<SyncSourceResponse> => {
                  const { id } = await sync.sources.create({ caller, vibe, ...body });
                  const source = await sync.queries.source(vibe.id, id);
                  if (!source) throw notFound("source_not_found", "The sync entry is gone.");
                  set.status = 201;
                  return { source };
                },
                { body: CreateSyncSourceRequest },
              )

              .put(
                "/sources/:key/credentials",
                async ({ caller, vibe, params, body }): Promise<SyncSourceResponse> => {
                  const { id } = await sync.sources.recredential(caller, vibe, params.key, body);
                  const source = await sync.queries.source(vibe.id, id);
                  if (!source) throw notFound("source_not_found", "The sync entry is gone.");
                  return { source };
                },
                { body: UpdateSyncCredentialsRequest },
              )

              .delete(
                "/sources/:key",
                async ({ caller, vibe, params }): Promise<SyncSourceResponse> => {
                  // Read before it goes, to show what was removed.
                  const listed = await sync.queries.sources(vibe.id);
                  const { id } = await sync.sources.remove(caller, vibe, params.key);
                  const source = listed.find((each) => each.id === id);
                  if (!source) throw notFound("source_not_found", "The sync entry is gone.");
                  return { source };
                },
              )

              .get(
                "/sources/:key/inbox",
                async ({ caller, vibe, params, query }): Promise<SyncInboxPage> => ({
                  events: await sync.sources.received(caller, vibe, params.key, query.limit),
                }),
                { query: SyncInboxQuery },
              )

              .get("/threads/:id/sync", ({ caller, vibe, params }): Promise<SyncedView> =>
                sync.attach.synced(caller, vibe, params.id),
              )

              .post(
                "/threads/:id/sync",
                ({ caller, vibe, params, body }): Promise<SyncThreadResponse> =>
                  sync.attach.attach({ caller, vibe, messageId: params.id, target: body.target }),
                { body: SyncThreadRequest },
              )

              // ── Schemas ──────────────────────────────────────────────────
              // What structured data may hold. The registry belongs to the
              // team: every vibe of it reads the same schemas, and anyone on
              // the team can read them.

              .get("/schemas", async ({ vibe }): Promise<SchemasPage> => ({
                schemas: (await messaging.schemas.list(vibe.teamId)).map(schemaView),
              }))

              .post(
                "/schemas",
                async ({ caller, vibe, body, set }): Promise<CreateSchemaResponse> => {
                  const { schema, created } = await messaging.schemas.register({
                    caller,
                    vibe,
                    name: body.name,
                    version: body.version,
                    description: body.description,
                    definition: body.schema,
                  });
                  set.status = created ? 201 : 200;
                  return { schema: schemaView(schema), created };
                },
                { body: CreateSchemaRequest },
              )

              .get("/schemas/:id", async ({ vibe, params }): Promise<{ schema: Schema }> => ({
                schema: schemaView(await messaging.schemas.get(vibe.teamId, decoded(params.id))),
              }))

              // ── Schedules ────────────────────────────────────────────────
              // Posts to make later. Each fires as whoever scheduled it, with
              // the access they have when it does.

              .get(
                "/schedules",
                async ({ caller, vibe, query }): Promise<SchedulesPage> => {
                  const scope = await identity.authorizer.scope(caller, vibe.id);
                  let threadId: string | undefined;
                  if (query.re !== undefined) {
                    const message = await messaging.queries.getMessage(vibe.id, query.re);
                    if (!message || !scope.allows(message.channel)) throw messageNotFound(query.re);
                    threadId = message.re ?? message.id;
                  }
                  return {
                    schedules: await automation.queries.list(
                      vibe.id,
                      {
                        channel: parseChannelPattern(query.channel),
                        by: actorFilter(query.by, caller),
                        threadId,
                        all: query.all === "true",
                        limit: query.limit,
                      },
                      scope,
                      caller,
                    ),
                  };
                },
                { query: SchedulesQuery },
              )

              .post(
                "/schedules",
                async ({ caller, vibe, body, set }): Promise<ScheduleResponse> => {
                  const id = await automation.schedules.create({
                    caller,
                    vibe,
                    channel: body.channel,
                    re: body.re,
                    text: body.text,
                    labels: body.labels,
                    blocks: body.blocks,
                    noSync: body.noSync,
                    timing: {
                      in: milliseconds(body.in),
                      at: time(body.at),
                      every: milliseconds(body.every),
                      for: milliseconds(body.for),
                      times: body.times,
                      until: time(body.until),
                    },
                  });
                  set.status = 201;
                  return { schedule: await scheduleView(caller, vibe, id) };
                },
                { body: CreateScheduleRequest },
              )

              .get(
                "/schedules/:id",
                async ({ caller, vibe, params }): Promise<ScheduleResponse> => ({
                  schedule: await scheduleView(caller, vibe, params.id),
                }),
              )

              .delete(
                "/schedules/:id",
                async ({ caller, vibe, params }): Promise<CancelScheduleResponse> => {
                  const { canceled } = await automation.schedules.cancel({
                    caller,
                    vibe,
                    id: params.id,
                  });
                  // Whoever may cancel it may see what they canceled, even
                  // holding `manage` in a channel they can't read.
                  const schedule = await automation.queries.get(vibe.id, params.id);
                  if (!schedule) throw scheduleNotFound(params.id);
                  return { schedule, canceled };
                },
              )

              // ── Tasks ────────────────────────────────────────────────────
              // A task is a thread, so it is read, followed and replied to like
              // any other. These routes are for the state the vibe keeps for it.

              .get(
                "/tasks",
                async ({ caller, vibe, query, request }): Promise<TasksPage> => {
                  const scope = await identity.authorizer.scope(caller, vibe.id);
                  const { state } = query;
                  return {
                    tasks: await tasks.queries.list(
                      vibe.id,
                      {
                        channel: parseChannelPattern(query.channel),
                        states: state === "all" ? null : state === "open" ? OPEN_STATES : [state],
                        by: actorFilter(query.by, caller),
                        for: query.for?.toLowerCase(),
                        labels: labelFilters(request),
                        limit: query.limit,
                      },
                      scope,
                      now(),
                    ),
                  };
                },
                { query: TasksQuery },
              )

              .post(
                "/tasks",
                async ({ caller, vibe, body, set }): Promise<CreateTasksResponse> => {
                  if ("thread" in body) {
                    const id = await tasks.create.adopt({
                      caller,
                      vibe,
                      messageId: body.thread,
                      needs: body.needs,
                      for: body.for,
                    });
                    set.status = 201;
                    return {
                      tasks: [await taskDetail(caller, vibe, id)],
                      created: true,
                      unresolved: [],
                    };
                  }
                  const result = await tasks.create.execute({
                    caller,
                    vibe,
                    channel: body.channel,
                    tasks: body.tasks,
                    idempotencyKey: body.idempotencyKey,
                  });
                  set.status = result.created ? 201 : 200;
                  return {
                    tasks: await tasksAsWritten(
                      caller,
                      vibe,
                      await tasks.queries.getMany(vibe.id, result.ids, now()),
                    ),
                    created: result.created,
                    unresolved: result.unresolved,
                  };
                },
                { body: CreateTasksRequest },
              )

              .post(
                "/tasks/claim",
                async ({ caller, vibe, body, request }): Promise<ClaimTaskResponse> => {
                  if ((body.id === undefined) === (body.ready === undefined)) {
                    throw invalid(
                      "invalid_request",
                      "Pass exactly one of `id`, to claim that task, or `ready`, to claim the next one in a channel.",
                    );
                  }
                  const leaseMs = body.lease === undefined ? undefined : body.lease * 1000;
                  const claimed =
                    body.id !== undefined
                      ? await tasks.change.claim({ caller, vibe, taskId: body.id, leaseMs })
                      : await tasks.claimReady.execute({
                          caller,
                          vibe,
                          channel: body.ready,
                          labels: parseLabelFilters(body.labels ?? []),
                          from: body.from ?? [],
                          waitMs: (body.wait ?? 0) * 1000,
                          leaseMs,
                          signal: request.signal,
                        });
                  if (!claimed) return { claimed: null };
                  const detail = await taskDetail(caller, vibe, claimed.task.id);
                  return { claimed: { ...detail, claim: claimView(claimed.claim) } };
                },
                { body: ClaimTaskRequest },
              )

              .get("/tasks/:id", ({ caller, vibe, params }): Promise<TaskDetail> =>
                taskDetail(caller, vibe, params.id),
              )

              .post(
                "/tasks/:id/renew",
                async ({ caller, vibe, params, body }): Promise<RenewTaskResponse> => {
                  const claim = await tasks.change.renew({
                    caller,
                    vibe,
                    taskId: params.id,
                    claimId: body.claim,
                    leaseMs: body.lease === undefined ? undefined : body.lease * 1000,
                  });
                  return { claim: claimView(claim) };
                },
                { body: RenewTaskRequest },
              )

              .post(
                "/tasks/:id/release",
                async ({ caller, vibe, params, body }): Promise<TaskDetail> => {
                  await tasks.change.release({
                    caller,
                    vibe,
                    taskId: params.id,
                    claimId: body.claim,
                  });
                  return taskDetail(caller, vibe, params.id);
                },
                { body: ReleaseTaskRequest },
              )

              .post(
                "/tasks/:id/complete",
                async ({ caller, vibe, params, body }): Promise<TaskDetail> => {
                  await tasks.change.complete({
                    caller,
                    vibe,
                    taskId: params.id,
                    claimId: body.claim,
                    result: body.result,
                  });
                  return taskDetail(caller, vibe, params.id);
                },
                { body: CompleteTaskRequest },
              )

              .post(
                "/tasks/:id/fail",
                async ({ caller, vibe, params, body }): Promise<TaskDetail> => {
                  await tasks.change.fail({
                    caller,
                    vibe,
                    taskId: params.id,
                    claimId: body.claim,
                    reason: body.reason,
                  });
                  return taskDetail(caller, vibe, params.id);
                },
                { body: FailTaskRequest },
              )

              .post(
                "/tasks/:id/block",
                async ({ caller, vibe, params, body }): Promise<TaskDetail> => {
                  await tasks.change.block({
                    caller,
                    vibe,
                    taskId: params.id,
                    claimId: body.claim,
                    reason: body.reason,
                    kind: body.kind,
                  });
                  return taskDetail(caller, vibe, params.id);
                },
                { body: BlockTaskRequest },
              )

              .post("/tasks/:id/unblock", async ({ caller, vibe, params }): Promise<TaskDetail> => {
                await tasks.change.unblock({ caller, vibe, taskId: params.id });
                return taskDetail(caller, vibe, params.id);
              })

              .post("/tasks/:id/reopen", async ({ caller, vibe, params }): Promise<TaskDetail> => {
                await tasks.change.reopen({ caller, vibe, taskId: params.id });
                return taskDetail(caller, vibe, params.id);
              })

              .post(
                "/tasks/:id/assign",
                async ({ caller, vibe, params, body }): Promise<TaskDetail> => {
                  await tasks.change.assign({
                    caller,
                    vibe,
                    taskId: params.id,
                    profile: body.for,
                  });
                  return taskDetail(caller, vibe, params.id);
                },
                { body: AssignTaskRequest },
              )

              .post(
                "/tasks/:id/needs",
                async ({ caller, vibe, params, body }): Promise<TaskDetail> => {
                  await tasks.change.setNeeds({
                    caller,
                    vibe,
                    taskId: params.id,
                    needs: body.needs,
                  });
                  return taskDetail(caller, vibe, params.id);
                },
                { body: TaskNeedsRequest },
              )

              .post(
                "/tasks/:id/cancel",
                async ({ caller, vibe, params, body }): Promise<TaskDetail> => {
                  await tasks.change.cancel({
                    caller,
                    vibe,
                    taskId: params.id,
                    reason: body.reason,
                  });
                  return taskDetail(caller, vibe, params.id);
                },
                { body: CancelTaskRequest },
              )

              .post(
                "/messages",
                async ({ caller, vibe, body, set }): Promise<PostMessageResponse> => {
                  // A thread that also starts on a platform has its targets
                  // checked first, and joined in the post's own commit.
                  const targets = body.sync ?? [];
                  const joining =
                    targets.length > 0 && body.channel !== undefined
                      ? await sync.attach.prepare(caller, vibe, body.channel, targets)
                      : null;
                  const result = await messaging.postMessage
                    .execute({
                      caller,
                      vibe,
                      channel: body.channel,
                      re: body.re,
                      text: body.text,
                      after: body.after,
                      idempotencyKey: body.idempotencyKey,
                      attachments: body.attachments,
                      labels: body.labels,
                      blocks: body.blocks,
                      noSync: body.noSync,
                      alongside: joining?.alongside,
                    })
                    .catch((error: unknown) => {
                      throw sync.attach.isTaken(error) ? alreadySynced() : error;
                    });
                  if (result.created) await joining?.joined(result);
                  const message = await messaging.queries.getMessage(vibe.id, result.messageId);
                  if (!message) throw messageNotFound(result.messageId);
                  set.status = result.created ? 201 : 200;
                  return {
                    message: result.created ? message : await asWritten(caller, vibe, message),
                    created: result.created,
                    unresolved: [...result.unresolved],
                  };
                },
                { body: PostMessageRequest },
              )

              .patch(
                "/messages/:id",
                async ({ caller, vibe, params, body }): Promise<ChangeMessageResponse> => {
                  const { changed, unresolved } = await messaging.changeMessage.edit({
                    caller,
                    vibe,
                    messageId: params.id,
                    text: body.text,
                    blocks: body.blocks,
                    revision: body.revision,
                  });
                  return {
                    message: await messageAfter(caller, vibe, params.id),
                    changed,
                    unresolved: [...unresolved],
                  };
                },
                { body: EditMessageRequest },
              )

              .delete(
                "/messages/:id",
                async ({ caller, vibe, params, query }): Promise<ChangeMessageResponse> => {
                  const { changed } = await messaging.changeMessage.delete({
                    caller,
                    vibe,
                    messageId: params.id,
                    revision: query.revision,
                  });
                  return { message: await messageAfter(caller, vibe, params.id), changed };
                },
                { query: DeleteMessageQuery },
              )

              .put(
                "/messages/:id/reactions/:emoji",
                async ({ caller, vibe, params }): Promise<ChangeMessageResponse> => {
                  const { changed } = await messaging.changeMessage.react({
                    caller,
                    vibe,
                    messageId: params.id,
                    emoji: decoded(params.emoji),
                  });
                  return { message: await messageAfter(caller, vibe, params.id), changed };
                },
              )

              .delete(
                "/messages/:id/reactions/:emoji",
                async ({ caller, vibe, params }): Promise<ChangeMessageResponse> => {
                  const { changed } = await messaging.changeMessage.react({
                    caller,
                    vibe,
                    messageId: params.id,
                    emoji: decoded(params.emoji),
                    remove: true,
                  });
                  return { message: await messageAfter(caller, vibe, params.id), changed };
                },
              )

              .put(
                "/messages/:id/labels",
                async ({ caller, vibe, params, body }): Promise<ChangeMessageResponse> => {
                  const { changed } = await messaging.changeMessage.label({
                    caller,
                    vibe,
                    messageId: params.id,
                    change: body,
                  });
                  return { message: await messageAfter(caller, vibe, params.id), changed };
                },
                { body: LabelsRequest },
              )

              .post(
                "/attachments",
                async ({ caller, vibe, query, headers, request, set }) => {
                  const length = headers["content-length"];
                  const file = await messaging.attachments.upload({
                    caller,
                    vibe,
                    name: query.name,
                    contentType: headers["content-type"] ?? null,
                    size: length === undefined ? null : Number(length),
                    body: request.body,
                  });
                  set.status = 201;
                  return file;
                },
                // The body is the file. A parser that claims every content type, and
                // reads nothing, leaves it as a stream for the blob store. Elysia's
                // own `parse: "none"` is ignored when routes aren't compiled.
                { parse: () => UNREAD, query: UploadQuery },
              )

              .get("/attachments/:id", async ({ caller, vibe, params }) => {
                const file = await messaging.attachments.open({ caller, vibe, id: params.id });
                return new Response(file.body, {
                  headers: {
                    // A picture is served as what it is, so a page can show it.
                    // Anything else is bytes: a script or a stylesheet someone
                    // uploaded must not load as one from this origin.
                    "content-type": SERVED_AS_ITSELF.has(file.type)
                      ? file.type
                      : "application/octet-stream",
                    "content-length": String(file.size),
                    // What its uploader said it is, for a client that asks.
                    "vibe-content-type": file.type,
                    // Always a download, never a page: an uploaded HTML file must
                    // not run on this origin.
                    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
                    "x-content-type-options": "nosniff",
                    "content-security-policy": "default-src 'none'; sandbox",
                    "cross-origin-resource-policy": "same-origin",
                    "cache-control": "private, no-store",
                  },
                });
              })

              // A socket that says when the log has moved, and never what
              // moved: each message is a number, the place the log got to.
              // What happened is asked of /events, which checks what this
              // caller may read. So anyone who can read something here may listen.
              .get("/live", async ({ caller, vibe, request }) => {
                const { hub } = options;
                if (!hub) {
                  throw notFound(
                    "live_unavailable",
                    "This Vibe holds no live connections.",
                    "Wait for events with GET /events?wait=20 instead. The SDK and the CLI do so by themselves.",
                  );
                }
                if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
                  throw invalid(
                    "invalid_request",
                    "GET /live opens a WebSocket, and nothing else.",
                  );
                }
                await identity.authorizer.require(caller, "read", {
                  vibeId: vibe.id,
                  channel: null,
                });
                upgrades.set(request, await hub.connect(vibe.id, request));
                return new Response(null, { status: 204 });
              })

              .get(
                "/events",
                async ({ caller, vibe, query, request }): Promise<EventsPage> => {
                  // A wait can outlive a change to the grants, so the feed reads
                  // the caller's scope again each time it looks: a channel made
                  // private meanwhile is closed, one opened meanwhile is seen.
                  return activity.service.poll({
                    vibeId: vibe.id,
                    scope: () => identity.authorizer.scope(caller, vibe.id),
                    after: query.after,
                    filter: {
                      channel: parseChannelPattern(query.channel),
                      re: query.re,
                      by: actorFilter(query.by, caller),
                      labels: labelFilters(request),
                      mentions: await mentioned(query.mentions, caller, vibe),
                      source: sourceFilter(query.source),
                      all: query.all === "true",
                    },
                    waitMs: query.wait * 1000,
                    limit: query.limit,
                    signal: request.signal,
                  });
                },
                { query: EventsQuery },
              ),
          ),
      );

  return {
    app,
    /** What a runtime serves: the app's answer, or the socket a route opened for the request. */
    async fetch(request: Request): Promise<Response> {
      const response = await app.fetch(request);
      return upgrades.get(request) ?? response;
    },
    sweep: () => tasks.sweep.run(),
    /** Posts the schedules that are due. The scheduler runs it each minute, before the sweep. */
    fireSchedules: () => automation.schedules.fireDue(),
    /** Delivers to every watcher that is behind. The scheduler's pass, for prompts that went missing. */
    deliverWatchers: () => automation.watchers.deliverDue(),
    /**
     * Delivers to one vibe's watchers, and runs its sync entries. What a
     * queue or a timer runs when asked through `deliveries`.
     */
    deliverVibe,
    /** Runs every sync entry that has something to send. The scheduler's pass. */
    syncDue: () => sync.deliveries.deliverDue(),
    /** All of the scheduler's work, once: what a runtime runs each minute. */
    tick,
  };
}

export type App = ReturnType<typeof createApp>;

function whoami(caller: Caller): Whoami {
  const { narrowed } = caller;
  const expiresAt = narrowed?.expiresAt ?? null;
  return {
    actor: {
      actor: caller.actorId,
      handle: caller.handle,
      name: caller.name,
      principal: caller.principal,
      profile: caller.profile,
    },
    role: caller.role,
    team: { id: caller.teamId, name: caller.teamName },
    ...(narrowed === null
      ? {}
      : { narrowed: { expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() } }),
  };
}

/** The kinds of file that keep their type when they are served: pictures a page shows as pictures. */
const SERVED_AS_ITSELF = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/** What the upload route's parser reports as the body, having left the real one alone. */
const UNREAD = "unread";

/** The most a webhook's body holds. GitHub's largest are of this order, and nothing here needs more. */
const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

const webhookTooLarge = () =>
  tooLarge("too_large", "A webhook's body holds up to 2 MB.", "Larger events are not synced.");

/** A sync entry as a reader sees it: with the channels it maps among those they can read. */
function visibleTo(scope: ChannelScope, source: SyncSource): SyncSource {
  return {
    ...source,
    mappings: source.mappings.filter((mapping) => scope.allows(mapping.channel)),
  };
}

function bearer(header: string | undefined): string | null {
  return /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1] ?? null;
}

/** Compares in time that depends only on the lengths, not on where the strings differ. */
function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i % b.length] ?? 0);
  return difference === 0;
}

/** Says which field is wrong and why, from the first thing validation found. */
function describe(
  issue: { path?: unknown; message?: unknown; summary?: unknown } | undefined,
): string {
  if (!issue) return "The request is malformed.";
  const path = Array.isArray(issue.path)
    ? issue.path
        .map((part) =>
          String(typeof part === "object" && part ? (part as { key: unknown }).key : part),
        )
        .join(".")
    : typeof issue.path === "string"
      ? issue.path.replace(/^\//, "").replaceAll("/", ".")
      : "";
  const message = String(issue.message ?? issue.summary ?? "The request is malformed.");
  return path ? `${path}: ${message}` : message;
}

/**
 * `me` filters by the caller: a person and their profiles, or the one profile
 * the caller writes as. Anything else is a handle or an actor ID, with `=` in
 * front of it to mean that actor alone, and none of their profiles.
 */
function actorFilter(by: string | undefined, caller: Caller): string | undefined {
  if (by === undefined || by === "me") return by === "me" ? caller.handle : undefined;
  const exactly = by.startsWith("=");
  const named = (exactly ? by.slice(1) : by).replace(/^@/, "");
  // An actor ID is matched as it is written. A handle is lowercase.
  const actor =
    named === "me" ? caller.handle : named.startsWith("vibe:") ? named : named.toLowerCase();
  return exactly ? `=${actor}` : actor;
}

/** A `source` filter as it is matched: a sync entry's key, or `vibe`, in lowercase. */
function sourceFilter(source: string | undefined): string | undefined {
  return source?.trim().toLowerCase() || undefined;
}

/**
 * Every `label` in the query string. Read from the URL because a filter
 * repeats, and how a repeated key reaches a handler differs between Elysia's
 * compiled and dynamic modes.
 */
function labelFilters(request: Request): LabelFilter[] {
  return parseLabelFilters(new URL(request.url).searchParams.getAll("label"));
}

/**
 * A path segment as the client wrote it. Whether a segment arrives decoded
 * depends on how Elysia matched the route, and an emoji always travels encoded.
 */
function decoded(segment: string): string {
  if (!/%[0-9a-f]{2}/i.test(segment)) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A span a client gave in seconds, in the milliseconds the domain keeps time in. */
function milliseconds(seconds: number | undefined): number | undefined {
  return seconds === undefined ? undefined : seconds * 1000;
}

const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A time a client gave, as ISO 8601 with its zone. Anything else is left for
 * the domain to refuse: without a zone a time would be read as local on one
 * runtime and as UTC on another, and each runtime accepts loose forms of its own.
 */
function time(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  return ZONED.test(iso) ? Date.parse(iso) : Number.NaN;
}

function schemaView(schema: StoredSchema): Schema {
  return {
    id: schemaId(schema),
    name: schema.name,
    version: schema.version,
    description: schema.description,
    schema: { ...schema.definition },
    createdBy: schema.createdBy,
    createdAt: new Date(schema.createdAt).toISOString(),
  };
}

function personView(user: User) {
  return { id: user.id, handle: user.handle, name: user.name, role: user.role };
}

/** A token as the API shows it. `vibes` names the vibes of delegated ones, by ID, where they are known. */
function heldToken(token: TokenView, vibes: ReadonlyMap<string, string> = new Map()): HeldToken {
  const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());
  return {
    id: token.id,
    kind: token.kind,
    label: token.label,
    createdAt: new Date(token.createdAt).toISOString(),
    expiresAt: iso(token.expiresAt),
    revokedAt: iso(token.revokedAt),
    current: token.current,
    delegated: token.delegated && {
      vibe: { id: token.delegated.vibeId, name: vibes.get(token.delegated.vibeId) ?? null },
      profile: token.delegated.profile,
      can: Object.fromEntries(
        Object.entries(token.delegated.can).map(([pattern, list]) => [pattern, [...list]]),
      ),
      mintedWith: token.delegated.mintedWith,
    },
  };
}

function serviceView(service: StoredService): Service {
  return {
    id: principalId("service", service.id),
    name: service.name,
    description: service.description,
    createdBy: service.createdBy,
    createdAt: new Date(service.createdAt).toISOString(),
  };
}

function claimView(claim: { id: string; expiresAt: number }) {
  return { id: claim.id, expiresAt: new Date(claim.expiresAt).toISOString() };
}

function messageNotFound(id: string) {
  return notFound("message_not_found", `No message has the ID ${id}, or you can't read it.`);
}
