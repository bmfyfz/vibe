# Architecture

How Vibe is put together, and why: what it is made of, how writes stay safe when many agents make them at once, where it runs, and what it stores. For how to use it, see [the guide](guide.md). For what it doesn't do yet, see [known limitations](limitations.md).

## What Vibe is

A place where people and coding agents work in the same threads: channels, threads, labels, an ordered event log, and tasks with leases. Agents claim work, record state, report what they changed, and block until someone answers.

It owns its whole stack: Cloudflare for the runtime (Workers, D1, Durable Objects, R2, Queues), driven by the `cf` CLI, and a Bun monorepo for the code.

Four surfaces, one protocol:

| Surface     | What                                                                                 | Runs on                           |
| ----------- | ------------------------------------------------------------------------------------ | --------------------------------- |
| `vibe` CLI  | `vibe post dev "…"`, `vibe wait --mentions --as fx`, `vibe tasks claim --ready work` | Bun, shipped as a compiled binary |
| `@vibe/sdk` | `vibe().post('deploys', '…')`, `tasks.claim()`, `events()`                           | Anything with `fetch`             |
| HTTP API    | JSON over `/v1/vibes/:vibe/…`                                                        | Cloudflare Worker                 |
| Web app     | Channels as a tree, threads, tasks and live activity, for people                     | A browser, served by the Worker   |

**Goals:** agent-first ergonomics (every write is safe to retry and safe to race), an event log nothing can be missed from, a domain model that doesn't know Cloudflare exists.

**Non-goals for v1:** a hosted service for many organisations. See the [open decisions](limitations.md#open-decisions).

## Ubiquitous language

The words the code, the API, the CLI and these documents all use. The container is a **vibe**, lowercase.

| Term          | Meaning                                                                                               | Identified by                                              |
| ------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Team          | The tenant. Owns vibes, people, services                                                              | `team_…`                                                   |
| Vibe          | Container for channels, grants and one event log. Every team has `general`                            | Name, unique per team                                      |
| Channel       | A path such as `dev` or `www/production`. Created by its first post. `www/` names a subtree           | Its path, immutable                                        |
| Thread        | A root message and its replies, one level deep                                                        | ID of its root                                             |
| Message       | Markdown by one actor, plus labels, reactions, attachments, blocks                                    | `msg_…` (also a cursor)                                    |
| Attachment    | A file on a message, stored in R2. Up to 10 per message, 100 MB each                                  | `att_…`                                                    |
| Label         | `key=value` on a message. One value per key. `vibe.*` is reserved                                     | Its key                                                    |
| Principal     | Who holds the credential: a **user** or a **service**                                                 | `vibe:user:u_…`, `vibe:service:s_…`                        |
| Profile       | A named identity inside a principal, e.g. an agent. No permissions of its own                         | `fx`                                                       |
| Actor         | A principal, optionally with a profile. What a write is attributed to                                 | `vibe:user:u_…+fx`, shown as _fx via ada_, handle `ada/fx` |
| Grant         | Permissions (`read post react label sync manage`) at channel patterns, for named principals           | `g4`                                                       |
| Event         | A record of one change, in vibe order                                                                 | Its cursor                                                 |
| Task          | A thread with a state the vibe keeps: `waiting ready claimed blocked completed failed canceled`       | ID of its root                                             |
| Claim         | A lease on a task, up to 5 minutes, renewable                                                         | Claim token                                                |
| Schema        | A JSON Schema for an object, under a name and a version. One registry per team                        | `sandbox@1`                                                |
| Block         | Data on a message that matched a schema when the message was written                                  | Its place on the message                                   |
| Schedule      | A post to make later, once or at an interval, as whoever scheduled it                                 | `sch_…`                                                    |
| Watcher       | A URL that a vibe's matching events are posted to, signed, in order                                   | `w_…`, and its name in the vibe                            |
| Limit         | A `can` map a caller is held to: the most it can do, where its principal can do as much               | Carried by a delegated token (`dt_…`), or by a request     |
| Sync entry    | A platform's channels mapped to a vibe's channels, with credentials, acting as one service            | Its key in the vibe, such as `slack`                       |
| Platform user | Someone who wrote on Slack, GitHub or Linear, shown through the entry's service: _Malte via support_  | `vibe:service:s_…+slack:user:U123`                         |
| Session       | A browser's sign-in: a secret in a cookie the page can't read, good for 30 days                       | `ses_…`                                                    |
| Budget        | How often something may be tried from one network address in a stretch of time, before `rate_limited` | Its name, and the address: `credential:203.0.113.7`        |

## What Vibe supplies itself

Vibe leans on no other service for identity, compute or secrets. Each need is met inside it.

| Need                                | How Vibe meets it                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Who a person is                     | Own users and API tokens. Roles: `owner`, `member`, `viewer`                               |
| Who a machine is                    | **Services**: named machine principals with tokens, for CI and workers                     |
| Who can do what                     | **Grants**. A new vibe starts with `g1`, every person on the team, and `g2`, every service |
| Naming a person in a grant          | By handle. Handles are unique on a team; email is optional                                 |
| Reaching Slack, GitHub and Linear   | Sync runs **inside Vibe**. An entry is data, made by a team owner, and acts as a service   |
| Keeping a platform's secrets        | Sealed under a key derived from the operator's secret                                      |
| Who may send a thread to a platform | The `sync` permission, which also covers writing as the platform's users                   |
| Handing an agent less than you have | **Delegated tokens**: short-lived, locked to one profile, narrowed to a `can` map          |
| Reacting to events from outside     | **Webhook watchers**: Vibe POSTs matching events to a URL, HMAC-signed, retried            |
| Running without Cloudflare          | `vibe serve`: the same code on Bun + `bun:sqlite`                                          |

## Bounded contexts

```
┌──────────────────────┐        ┌───────────────────────────────────────┐
│ Identity & Access    │◄───────│ Messaging (core)                      │
│ Team, User, Service, │ ActorId│ Vibe, Channel, Thread, Message,       │
│ Token, Profile,      │ + Auth-│ Attachment, Label, Reaction, Mention  │
│ AccessPolicy (grants)│ orizer └───────────────▲───────────────────────┘
└──────────▲───────────┘ port                   │ a task *is* a thread
           │                    ┌───────────────┴───────────────────────┐
           │                    │ Tasks (core)                          │
           └────────────────────│ Task, Claim, Needs, Plan              │
                                └───────────────────────────────────────┘
        all three emit domain events ──► Activity: EventLog, Cursor, Filter, wait/tail
                                          └──► Automation: Schedule, Watcher
                                          └──► Sync: Source, SyncedThread, Copy ◄──► Slack / GitHub / Linear
```

| Context           | Aggregates                                              | Notable value objects                          | Owns the rule that…                                                                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity & Access | Team, User, Service, Token, AccessPolicy (one per vibe) | ActorId, Handle, Permission, ChannelPattern    | Most specific pattern wins, then closest principal, ties add up, role caps the result. You can't grant more than you have                                                                                                                                           |
| Messaging         | Vibe, Channel, Thread, Attachment, Schema               | ChannelPath, MessageId, Label, Emoji, Revision | Threads are one level deep. A post carries only files its author uploaded. Only the author edits. Delete leaves a tombstone. `reply --after` lands only if still newest. Label changes can be conditional                                                           |
| Tasks             | Task                                                    | TaskState, Claim, Lease                        | One claim wins. A dead claim changes nothing. Completing a task readies what waited only for it. Needs can't form a cycle                                                                                                                                           |
| Activity          | — (append-only log)                                     | Cursor, Filter                                 | An event matches a filter if its message matched before _or_ after the change. One filter language for `read`, `tail`, `wait` and watchers                                                                                                                          |
| Automation        | Schedule, Watcher                                       | Timing, Plan, Tail                             | A schedule fires as its author as they are when it fires. Nothing repeats faster than once a minute. Firings the scheduler missed are skipped, not made up for. A watcher is delivered each event at least once, in the log's order, and never what it wrote itself |

| Sync | Source (a sync entry), SyncedThread | Target, Mapping, Copy, PlatformUser, Signature | A platform thread syncs with one vibe thread. A message goes to every platform thread its thread syncs with, except the one it came from. `noSync` keeps a message or a thread off every platform. Labels never leave. Five retries, then the failure is recorded and the next message goes |

Each context is a package with three layers and a hard dependency rule:

```
domain/          aggregates, value objects, domain events, domain errors. Imports kernel only
application/     commands, queries, ports (Repository, Authorizer, Clock, Ids)
infrastructure/  Drizzle repositories and read models
```

Commands go through aggregates. Queries (thread lists, the event feed) are Drizzle read models and skip them.

## Consistency model

This is the part that makes agents safe, and the part D1 constrains most: D1 has no interactive transactions, only all-or-nothing `batch()`.

**One command = one batch = N events.** A handler loads state, runs the domain method (pure, returns events or a domain error), then commits state rows, projections and event-log rows in a single batch. Repositories add Drizzle statements to a unit of work; committing it is one `db.batch()`.

**The thread is the unit of concurrency.** Each thread carries a `version`. Every event row records `(thread_id, thread_version)` under a unique index, so a write computed from stale state violates the index and rolls the whole batch back. The handler reloads and re-runs the domain method, which then either succeeds or returns the right error (`label_conflict`, `task_claimed`, `newer_message`, `revision_conflict`). Messages, labels and task state in a thread all share that one version.

**Order comes free.** D1 has a single writer, so the event log's autoincrement `seq` is commit order with no gaps a reader could skip over. A cursor is an opaque encoding of `seq`. The log records which event posted each message, which is why a message ID works as a cursor.

**A change to a message is a change to its thread.** A label, a reaction, an edit and a delete each load the thread with the message they name and the thread's root, in one statement, run the domain method, and commit with the thread's next version. That is the whole mechanism behind conditional labels and `revision`: of two writers that read the same state, the second commit reuses a version, fails, and is decided again from what the first left, where its condition no longer holds. A change that leaves the message as it was writes nothing and takes no version.

**Events carry what filters match on.** Each event stores a snapshot of its message's labels (its own and its root's) and mentions as the change left them, and as they stood before when the change altered either. Filters read the snapshot, not the live message, so an event matches the same way however late it is read: a follower of `state=open` sees a thread enter that view and sees the change that takes it out. A filter on mentions matches only the events that change what a message says, a post, an edit, a deletion, so that a reaction to a message that mentions someone, or its task changing hands, doesn't mention them again.

**Retries.** An idempotency key maps `(principal, key)` to the message it created, written in the same batch.

**Leases are lazy.** A task is claimable when `state = ready`, or `state = claimed` and the lease has passed. Correctness never waits on a timer. A cron sweep only tidies up: it flips the label and emits `task.expired`.

**The event log is the outbox.** Watchers and sync entries keep their own cursor into the log, so a lost queue message delays a delivery but can't lose it.

## Cloudflare topology

```
 vibe CLI / SDK / agents / browsers        Slack, GitHub, Linear
        │ HTTPS                          WebSocket (poke only)    ▲ │ webhooks in, API calls out
        ▼                                      │
┌─────────────────────────────────────┐   ┌────▼───────────────────────┐
│ Worker: vibe-api (Elysia)           │──►│ Durable Object: VibeHub    │
│  fetch      HTTP API                │   │ one per vibe, hibernating  │
│  scheduled  every minute: due       │   │ broadcasts {seq}, no state │
│             schedules, lease sweep, │   └────────────────────────────┘
│             event retention         │
│  queue      watcher and sync        │──► Queues: vibe-deliveries
│             deliveries              │
│  assets     the web app's files     │
└───────┬──────────────────┬──────────┘
        ▼                  ▼
   D1: vibe            R2: vibe-attachments
   system of record    files up to 100 MB
```

- **D1 is the only source of truth.** No read replicas in v1: agents post and read back immediately, and need to see their own writes.
- **VibeHub holds no data.** After a commit the Worker pokes the hub with the new `seq`; the hub fans that number out to connected sockets; clients then pull `GET /events?after=…` through the normal authorized path. Sockets hibernate, so an idle `vibe wait` costs nothing. A missed poke is covered by a 25-second re-poll.
- **Long-poll fallback** for clients without WebSockets, and for a Vibe without a hub: the Worker re-queries D1 each second for up to `wait` seconds.
- **R2 holds attachment bytes; D1 holds their metadata.** Uploads stream through the Worker, which checks access on the way in and on the way out. Downloads are always served as `attachment`, so an uploaded HTML file can't run on the API's origin.
- **The queue carries prompts, not deliveries.** A write to a vibe that has watchers sends `vibe-deliveries` the vibe's ID, after the response. The consumer runs a delivery pass over that vibe's watchers, and a failed delivery asks for another pass with the wait as the message's delay. What each watcher is owed is its cursor in D1, so a message that is lost, late or repeated changes when a delivery goes out, never whether.
- **Cron** does the timed work at one-minute granularity, which matches the shortest schedule interval: due schedules, the task sweep, and a delivery pass for any watcher a prompt missed.
- **The web app is static files beside the API.** The Worker's assets hold `apps/web/dist`. Requests under `/v1/` go to the Worker first, and any other path that isn't a file gets `index.html`, so the page's own routes survive a reload. The page talks to `/v1` on its own origin and to nothing else.
- **Sync shares the queue and the cron.** A write to a vibe with a sync entry prompts the same pass a watcher's does. A platform's webhook is answered once the event is stored and applied.
- **`vibe serve` is the same app with other parts under it.** SQLite in a file for D1, a directory for R2, Bun's WebSockets for VibeHub, and timers for the queue and the cron trigger. `packages/server` holds the app and knows none of them.

## Data model (D1)

```
teams, users, actors                         actors: one row per principal, and per profile
                                             users(github_id, github_login): unique(team_id, github_id)
tokens(id, hash, user_id, label, revoked_at) a revoked token keeps its row: what it minted is told by it
services(id, team_id, name, removed_at)      unique(team_id, name). Its handle is taken in `actors`, for good
service_tokens(id, hash, service_id, label, revoked_at)
delegated_tokens(id, hash, principal, vibe_id, profile, can, expires_at, minted_with, revoked_at)
                                             minted_with: the token or session it works only as long as
vibes(team_id, name)                         unique(team_id, name), names stored lowercase
grants(vibe_id, n, principals, can, revoked_at)             pk(vibe_id, n). No rows: the defaults govern
policy_revisions(vibe_id, revision)                         pk of both: the lock on a vibe's grants as a whole
channels(vibe_id, path)                      pk
threads(id, vibe_id, channel, version, reply_count, last_message_id, last_activity_at)
messages(id, thread_id, reply_to, actor_id, text, blocks, position, revision, deleted_at, created_at)
                                             unique(thread_id, position). deleted_at marks a tombstone
attachments(id, vibe_id, uploader, uploaded_by, blob_key, name, type, size)
message_attachments(attachment_id, message_id, position)    pk(attachment_id): a file joins one message
message_labels(message_id, key, value, thread_id)           pk(message_id, key): one value per key
reactions(message_id, emoji, actor_id)                      pk of all three: each actor reacts once
mentions(message_id, actor_id, thread_id)                   pk(message_id, actor_id)
schemas(team_id, name, version, description, definition)    pk of the first three: a version is written once
tasks, task_needs                            a task's state, beside its thread, and what it waits for
events(seq, vibe_id, type, channel, thread_id, thread_version, message_id, actor_id, payload, facets, created_at)
                                             unique(thread_id, thread_version), index(vibe_id, seq)
idempotency(principal, key, target, message_id)             pk(principal, key)
schedules(id, vibe_id, channel, thread_id, reply_to, actor_id, principal, profile, text, labels, blocks,
          state, next_at, every, until, remaining, runs, last_run_at, last_message_id, reason)
                                             index(state, next_at): what the scheduler reads each minute
watchers(id, vibe_id, name, url, tail, secret, actor_id, principal, state, reason)
                                             unique(vibe_id, name)
watcher_cursors(watcher_id, seq, attempts, retry_at, leased_until, last_status, last_error, delivered_at)
                                             pk(watcher_id): what a watcher has been delivered, and who holds it
sessions(id, hash, user_id, created_at, expires_at, opened_with, user_agent)
                                             unique(hash): a browser's sign-in. opened_with: the token it ends with
attempts(key, window_start, count, expires_at)              pk(key): tries counted against a budget, for one address
sync_sources(id, vibe_id, key, platform, principal, config, credentials, state, reason, created_by)
                                             unique(vibe_id, key). credentials are sealed
sync_cursors(source_id, seq, leased_until)   pk(source_id): how far an entry has read the log, and who holds it
sync_threads(id, source_id, thread_id, platform_channel, platform_thread, url, since_seq, state)
                                             unique(source_id, platform_thread): a platform thread syncs once
sync_messages(sync_thread_id, message_id, source_id, direction, platform_message, url, state, attempts, retry_at, last_error)
                                             pk(sync_thread_id, message_id), unique(source_id, platform_message):
                                             which message is which platform message, and where its delivery stands
sync_inbox(source_id, delivery_id, event, body, state, note, received_at)
                                             pk(source_id, delivery_id): what a platform sent, and what came of it
```

`messages` gained `source`, the key of the entry a message came in through, and `no_sync`. `schedules` gained `no_sync`.

The schema is defined once in Drizzle (`packages/store/src/schema.ts`); `drizzle-kit generate` writes the SQL migrations that `cf d1 migrations apply` runs on D1. On bun:sqlite the store applies them itself, and records each in `vibe_migrations`.

Access checks run in the domain, not in SQL. A vibe's grants are few, so a request loads the ones in force and resolves them, for the caller, into a scope: a function from channel to yes or no, with a flag for "every channel". Read models page by their other filters and drop what the scope excludes, reading on until a page is full or nothing is left. A scope is rules, not a list of channels, so a channel created a moment later is judged the same way. A request that waits reads the scope again each time it looks, after the events and never before, so it has every grant those events were written under.

## HTTP API (sketch)

```
POST   /v1/login/device                          start GitHub's device flow. No token needed
POST   /v1/login/device/token                    { deviceCode }: pending, or a new token for whoever approved
GET    /v1/login                                 which ways of signing in this Vibe has
POST   /v1/session                               { token }: a browser session, as a cookie. DELETE ends it
POST   /v1/session/device                        { deviceCode }: pending, or a session for whoever approved
GET    /v1/sessions                              your browser sessions      DELETE /v1/sessions/:id ends one
GET    /v1/tokens                                the tokens you hold, never their secrets
DELETE /v1/tokens/:id                            revokes one of them: `tok_…`, or a delegated `dt_…`
POST   /v1/sync/webhooks/:source                 a platform's webhook. No token: its signature is checked
GET    /v1/whoami                                who the token is
GET    /v1/services                              POST { name, description }, as a team owner
POST   /v1/services/:name/tokens                 DELETE /v1/services/:name
GET    /v1/services/:name/tokens                 DELETE /v1/services/:name/tokens/:id, as a team owner
GET    /v1/vibes/:p/whoami                       the same, with what you can do at each channel pattern
GET    /v1/vibes/:p/actors                       the people and agents you can see
GET    /v1/vibes/:p/channels                     POST { path, private } to create one
GET    /v1/vibes/:p/threads?channel=&label=&by=&mentions=&source=&after=&limit=
GET    /v1/vibes/:p/threads/:id                  with `sync`: what it syncs with, and what was not delivered
GET    /v1/vibes/:p/threads/:id/sync             POST { target }: sync it with a platform channel or thread
POST   /v1/vibes/:p/messages                     { channel | re, text, attachments, labels, blocks, after, idempotencyKey,
                                                   noSync, sync: [targets] }
GET    /v1/vibes/:p/sources                      POST { key, platform, service, map, credentials, api }, as a team owner
PUT    /v1/vibes/:p/sources/:key/credentials     { token, secret }      DELETE /v1/vibes/:p/sources/:key
GET    /v1/vibes/:p/sources/:key/inbox           the last events the platform sent, and what came of each
POST   /v1/vibes/:p/attachments?name=            raw body, returns { id, name, type, size }
GET    /v1/vibes/:p/attachments/:id              the file
PATCH  /v1/vibes/:p/messages/:id                 { text, blocks, revision }  DELETE ?revision=
PUT    /v1/vibes/:p/messages/:id/labels          { set, unset, if }
PUT    /v1/vibes/:p/messages/:id/reactions/:emoji                          DELETE
GET    /v1/vibes/:p/events?after=&wait=&channel=&re=&label=&by=&mentions=&source=
GET    /v1/vibes/:p/grants                       POST { principals, can }
PATCH  /v1/vibes/:p/grants/:id                   { add, remove, can }      DELETE
POST   /v1/vibes/:p/grants/explain               { channel, user | service }
POST   /v1/vibes/:p/tokens                       { profile, can, ttl }: a delegated token
GET    /v1/vibes/:p/watchers                     POST { name, url, channel, re, by, mentions, labels, all }
DELETE /v1/vibes/:p/watchers/:id                 by ID or by name
GET    /v1/vibes/:p/live                         WebSocket. Each message is a number: how far the log got
GET    /v1/vibes/:p/schemas                      POST { name, version, description, schema }
GET    /v1/vibes/:p/schemas/:id                  one schema, by `name@version`
GET    /v1/vibes/:p/schedules?channel=&by=&re=&all=
POST   /v1/vibes/:p/schedules                    { channel | re, text, labels, blocks, in, at, every, for, times, until }
GET    /v1/vibes/:p/schedules/:id                DELETE cancels it
GET    /v1/vibes/:p/tasks?channel=&state=&by=&for=&label=
POST   /v1/vibes/:p/tasks                        { channel, tasks: [1..15] } | { thread }
POST   /v1/vibes/:p/tasks/claim                  { id } | { ready: channel, labels, from, wait }, and lease
GET    /v1/vibes/:p/tasks/:id
POST   /v1/vibes/:p/tasks/:id/{renew,release,complete,fail,block,unblock,reopen,assign,needs,cancel}
```

A request names a profile with the `Vibe-Profile` header, and asks to be held to less than its token allows with `Vibe-Can`, the JSON of a `can` map. `label` repeats in a query string, one filter each. The operator's routes, under `/v1/admin` with the deployment's secret, add people (`POST /users`), mint their tokens, list them and revoke one (`GET /users/:handle/tokens`, `DELETE /users/:handle/tokens/:id`), say which GitHub account is theirs (`PUT /users/:handle/github`), and run one pass of the scheduler (`POST /tick`).

Errors are `{ code, message, hint }` with one vocabulary of codes: `forbidden`, `message_not_found`, `message_deleted`, `newer_message`, `revision_conflict`, `label_conflict`, `reserved_label`, `duplicate_id`, `channel_exists`, `channel_granted`. For tasks: `claim_lost`, `task_claimed`, `task_not_owned`, `nothing_ready`, `timeout`. For structured data: `invalid_block`, `schema_not_found`, `schema_immutable`. Also `invalid_label`, `invalid_emoji`, `invalid_profile`, `invalid_grant`, `grant_not_found`, `user_not_found`, `invalid_schema`, `invalid_schedule`, `schedule_not_found` and `live_unavailable`. For services, tokens, watchers and signing in: `service_not_found`, `handle_taken`, `invalid_can`, `invalid_ttl`, `profile_locked`, `invalid_watcher`, `watcher_not_found`, `watcher_exists`, `too_many_watchers`, `login_unavailable`, `login_denied`, `login_expired`, `signup_closed`, `invalid_github_login`, `github_taken`, and `github_unavailable`, the one error that is another server's fault, with status 502. For sync: `invalid_source`, `source_not_found`, `source_exists`, `too_many_sources`, `invalid_target`, `already_synced`, `no_sync`, `sync_unavailable`, `webhook_refused` (401), and `platform_unavailable` (502). For credentials: `token_not_found`, `session_not_found`, and `rate_limited`, status 429, with `Retry-After` in seconds.

## Monorepo

```
vibe/
├── apps/
│   ├── api/          The Worker: D1, R2, VibeHub, the delivery queue, cron, assets. And the black-box suite
│   ├── cli/          `vibe`: thin over the SDK, `bun build --compile`. `vibe serve` runs the server
│   └── web/          The web app: Vite, React. Talks to the API through `@vibe/sdk` only
├── packages/
│   ├── kernel/       errors, ids, Clock, ChannelPath, and the UnitOfWork, EventLog and BlobStore ports
│   ├── identity/     ┐
│   ├── messaging/    │ one bounded context each: domain / application / infrastructure
│   ├── tasks/        │
│   ├── activity/     │
│   ├── automation/   │
│   ├── sync/         ┘
│   ├── server/       The HTTP API as an Elysia app, and the composition root. `./bun` serves it on Bun
│   ├── store/        Drizzle schema, migrations, executors (D1, bun:sqlite), blob stores (R2, files, memory)
│   ├── contracts/    Zod schemas for every request and response, shared by api and sdk
│   └── sdk/          @vibe/sdk
└── skills/vibe/      SKILL.md that teaches a coding agent the CLI
```

- **Bun** is the package manager, workspace tool, test runner and CLI runtime. The API runs on workerd, so nothing under `packages/*/domain` or `application` may import a Bun or Cloudflare API.
- **Boundaries are enforced by `package.json`** and Bun's isolated installs, so a package can import only what it declares: `tasks`, `automation` and `sync` depend on `messaging` and `identity`, and `automation` and `sync` read the log through `activity`; `server` wires them all and knows no runtime; nothing depends on `apps/*`; only `store` and `apps/api` know D1 and R2 exist, and only `apps/api` knows of Durable Objects and Queues.
- **Stack:** Elysia, Zod, Drizzle (schema, migrations, queries), and the `cf` CLI with `cloudflare.config.ts` in place of Wrangler.
- **Tooling is Bun's own:** `bun fmt` formats, `bun check` type-checks, `bun test` tests, and `bun lint` runs Biome as the linter only. `bun verify` runs all four. TypeScript is as strict as it goes: `strict` plus `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, unused-code and implicit-return checks.
- **One Drizzle database type everywhere.** Drizzle's D1 and bun:sqlite drivers have different types, so the store uses Drizzle's `sqlite-proxy` driver over a two-method executor. The D1 executor maps a batch to `D1Database.batch()`; the bun:sqlite one maps it to a transaction. Repositories are written once.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), small and incremental, scoped by package: `feat(messaging): …`.
- **Tests:** domain as pure unit tests; one black-box API suite that runs in-process on `bun:sqlite`, and against any running Vibe when `VIBE_TEST_URL` is set, which is how the D1 and R2 adapters are checked under `cf dev`, and the SQLite file, the directory of blobs and Bun's sockets under `vibe serve`.
