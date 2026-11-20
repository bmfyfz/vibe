import type { EventFacets } from "@vibe/kernel";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Times are epoch milliseconds. IDs are prefixed ULIDs, opaque to SQL.
const createdAt = () => integer("created_at").notNull();

// ── Identity & Access ────────────────────────────────────────────────────────

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdAt: createdAt(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    role: text("role", { enum: ["owner", "member", "viewer"] }).notNull(),
    createdAt: createdAt(),
    /**
     * The GitHub account this person signs in with, by its number, which
     * stays the same when the account is renamed. Set at their first sign-in.
     */
    githubId: integer("github_id"),
    /**
     * That account's login, lowercase. Before the first sign-in it is how an
     * operator says which account is theirs. Afterwards it is only for show.
     */
    githubLogin: text("github_login"),
  },
  (t) => [
    uniqueIndex("users_team_handle").on(t.teamId, t.handle),
    // One person per GitHub account.
    uniqueIndex("users_team_github").on(t.teamId, t.githubId),
    index("users_team_github_login").on(t.teamId, t.githubLogin),
  ],
);

/** Everyone a write can be attributed to: one row per principal, and one per profile of a principal. */
export const actors = sqliteTable(
  "actors",
  {
    /** The actor ID, such as `vibe:user:u_…` or `vibe:user:u_…+fx`. */
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    principal: text("principal").notNull(),
    profile: text("profile"),
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("actors_team_handle").on(t.teamId, t.handle)],
);

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the secret. The secret itself is shown once and never stored. */
    hash: text("hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    label: text("label"),
    createdAt: createdAt(),
    /** Set once it is revoked. The row stays: what it minted is told by it that it is over. */
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("tokens_user").on(t.userId)],
);

/**
 * A machine principal, such as a CI job or a worker: `vibe:service:s_…`. It
 * has tokens of its own and no role. Its grants alone decide what it can do.
 */
export const services = sqliteTable(
  "services",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id),
    /** Its handle. A team's people and services share one set of handles, through `actors`. */
    name: text("name").notNull(),
    description: text("description"),
    /** The actor that created it. */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    /** Set once the service is removed. Its tokens stop working, and what it wrote stays its own. */
    removedAt: integer("removed_at"),
  },
  (t) => [uniqueIndex("services_team_name").on(t.teamId, t.name)],
);

/** A service's tokens. Kept apart from people's: a token belongs to exactly one kind of principal. */
export const serviceTokens = sqliteTable(
  "service_tokens",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the secret. The secret itself is shown once and never stored. */
    hash: text("hash").notNull().unique(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id),
    label: text("label"),
    createdAt: createdAt(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("service_tokens_service").on(t.serviceId)],
);

/**
 * A short-lived token minted from a person's or a service's own: it works in
 * one vibe, writes as one profile, and can do no more than `can` allows of
 * what its principal can do when it is used.
 */
export const delegatedTokens = sqliteTable(
  "delegated_tokens",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the secret. The secret itself is shown once and never stored. */
    hash: text("hash").notNull().unique(),
    /** Whose access it narrows: `vibe:user:u_…` or `vibe:service:s_…`. */
    principal: text("principal").notNull(),
    vibeId: text("vibe_id").notNull(),
    /** The one profile it writes as. */
    profile: text("profile").notNull(),
    /** Channel pattern to permissions: the most it can do, where its principal can do as much. */
    can: text("can", { mode: "json" }).$type<Record<string, string[]>>().notNull(),
    /** The actor that minted it. */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    expiresAt: integer("expires_at").notNull(),
    /**
     * What its minter was recognised by: the ID of a token, a service's token
     * or a session. The token works only while that does. `null` for one
     * minted before this was recorded, which ends by itself.
     */
    mintedWith: text("minted_with"),
    /** Set once it is revoked by name. */
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("delegated_tokens_principal").on(t.principal, t.expiresAt)],
);

/**
 * Who can do what in which channels of a vibe. A vibe with no rows here has
 * never had its grants changed, and is governed by the defaults.
 */
export const grants = sqliteTable(
  "grants",
  {
    vibeId: text("vibe_id").notNull(),
    /** The grant's number within its vibe, shown as `g4`. Never reused. */
    n: integer("n").notNull(),
    principals: text("principals", { mode: "json" }).$type<unknown[]>().notNull(),
    /** Channel pattern to permissions, such as `{ "security/": ["read", "post"] }`. */
    can: text("can", { mode: "json" }).$type<Record<string, string[]>>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    /** A revoked grant keeps its rows, so its number is never handed out again. */
    revokedAt: integer("revoked_at"),
  },
  (t) => [primaryKey({ columns: [t.vibeId, t.n] })],
);

/**
 * The optimistic lock on a vibe's grants as a whole. Every change to them
 * records the revision it makes here. Two changes decided from the same grants
 * record the same revision, the second violates the primary key, and its whole
 * batch fails. The lock is on the policy, not on one grant, because whether a
 * change is allowed depends on all of them.
 */
export const policyRevisions = sqliteTable(
  "policy_revisions",
  {
    vibeId: text("vibe_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (t) => [primaryKey({ columns: [t.vibeId, t.revision] })],
);

/**
 * A person signed in from a browser. The browser holds the secret in a cookie
 * that page scripts can't read, and this row is what makes it mean someone:
 * deleting it signs them out, wherever the cookie still is.
 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    /** SHA-256 of the secret in the cookie. The secret itself is never stored. */
    hash: text("hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    /** The session is over at this time, whether or not anyone signed out. */
    expiresAt: integer("expires_at").notNull(),
    /**
     * The ID of the token the session was opened with, and ends with. `null`
     * for one opened through GitHub, where no token was shown.
     */
    openedWith: text("opened_with"),
    /** What the browser called itself when it signed in, cut short. For telling sessions apart. */
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user").on(t.userId), index("sessions_expires").on(t.expiresAt)],
);

/**
 * How often something was tried in the current stretch of time, under a key
 * that names what was tried and from where: refused credentials from one
 * address, sign-ins started from one address. What bounds guessing.
 */
export const attempts = sqliteTable(
  "attempts",
  {
    /** What is counted and for whom, such as `credential:203.0.113.7`. */
    key: text("key").primaryKey(),
    /** When the stretch being counted began. An attempt in a later one starts the count again. */
    windowStart: integer("window_start").notNull(),
    count: integer("count").notNull(),
    /** When that stretch ends, and the row means nothing any more. */
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("attempts_expires").on(t.expiresAt)],
);

// ── Messaging ────────────────────────────────────────────────────────────────

export const vibes = sqliteTable(
  "vibes",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    /** Lowercase, so names match regardless of case. */
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("vibes_team_name").on(t.teamId, t.name)],
);

export const channels = sqliteTable(
  "channels",
  {
    vibeId: text("vibe_id").notNull(),
    path: text("path").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.vibeId, t.path] })],
);

export const threads = sqliteTable(
  "threads",
  {
    /** The ID of the thread's root message. */
    id: text("id").primaryKey(),
    vibeId: text("vibe_id").notNull(),
    channel: text("channel").notNull(),
    /** Bumped by every change in the thread. See `events_thread_version`. */
    version: integer("version").notNull(),
    replyCount: integer("reply_count").notNull().default(0),
    lastMessageId: text("last_message_id").notNull(),
    lastActivityAt: integer("last_activity_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("threads_recent").on(t.vibeId, t.lastActivityAt),
    index("threads_channel").on(t.vibeId, t.channel, t.lastActivityAt),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id),
    vibeId: text("vibe_id").notNull(),
    /** The exact message answered, when that isn't the thread's root. */
    replyTo: text("reply_to"),
    actorId: text("actor_id").notNull(),
    text: text("text").notNull(),
    /** The thread's version when this message was posted: its place in the thread. */
    position: integer("position").notNull(),
    revision: integer("revision").notNull().default(1),
    /** Set once the message is a tombstone. Its text is emptied at the same time. */
    deletedAt: integer("deleted_at"),
    /** The structured data the message carries, each checked against its schema when written. */
    blocks: text("blocks", { mode: "json" })
      .$type<{ schema: string; version: number; data: Record<string, unknown> }[]>()
      .notNull()
      .default(sql`'[]'`),
    /** The key of the sync entry it came in through. `null` for a message written on the vibe. */
    source: text("source"),
    /** Kept off every synced platform. On a thread's root, the whole thread is. */
    noSync: integer("no_sync", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_thread_position").on(t.threadId, t.position),
    // Who wrote where: the `by` filter, and which actors a caller can see.
    index("messages_vibe_actor").on(t.vibeId, t.actorId, t.threadId),
  ],
);

export const messageLabels = sqliteTable(
  "message_labels",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    /** The message's thread, so a thread's labels are one index range. */
    threadId: text("thread_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    // One value per key.
    primaryKey({ columns: [t.messageId, t.key] }),
    index("message_labels_thread").on(t.threadId, t.key),
  ],
);

export const mentions = sqliteTable(
  "mentions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    /** Who the message mentions. Its text holds the same ID, as `@[actor-id]`. */
    actorId: text("actor_id").notNull(),
    threadId: text("thread_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.actorId] }),
    index("mentions_thread").on(t.threadId, t.actorId),
  ],
);

export const reactions = sqliteTable(
  "reactions",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    /** The emoji's normalized name, such as `eyes`. */
    emoji: text("emoji").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  // Each actor reacts with an emoji once.
  (t) => [primaryKey({ columns: [t.messageId, t.emoji, t.actorId] })],
);

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  vibeId: text("vibe_id").notNull(),
  /** The principal that uploaded the file. Until it joins a message, only they can read it. */
  uploader: text("uploader").notNull(),
  /**
   * The actor that uploaded it: the principal, or the profile it wrote as. A
   * caller under a limit posts only the files it uploaded itself. `null` on a
   * file from before this was kept.
   */
  uploadedBy: text("uploaded_by"),
  blobKey: text("blob_key").notNull(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  size: integer("size").notNull(),
  createdAt: createdAt(),
});

export const messageAttachments = sqliteTable(
  "message_attachments",
  {
    /** The primary key, so a file joins one message. A second attempt fails the whole commit. */
    attachmentId: text("attachment_id")
      .primaryKey()
      .references(() => attachments.id),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    position: integer("position").notNull(),
  },
  (t) => [index("message_attachments_message").on(t.messageId)],
);

/**
 * What structured data may hold: a JSON Schema under a name and a version. One
 * registry per team, shared by its vibes. A row never changes once written.
 */
export const schemas = sqliteTable(
  "schemas",
  {
    teamId: text("team_id").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    description: text("description"),
    definition: text("definition", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  // The primary key is what makes a version immutable: a second definition
  // under the same name and version fails its commit.
  (t) => [primaryKey({ columns: [t.teamId, t.name, t.version] })],
);

export const idempotency = sqliteTable(
  "idempotency",
  {
    principal: text("principal").notNull(),
    key: text("key").notNull(),
    /** What the key was first used for. Reusing it for something else is refused. */
    target: text("target").notNull(),
    messageId: text("message_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.principal, t.key] })],
);

// ── Activity ─────────────────────────────────────────────────────────────────

export const events = sqliteTable(
  "events",
  {
    /** Commit order. D1 has one writer, so a reader can never see a later seq before an earlier one. */
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    vibeId: text("vibe_id").notNull(),
    type: text("type").notNull(),
    channel: text("channel"),
    threadId: text("thread_id"),
    threadVersion: integer("thread_version"),
    messageId: text("message_id"),
    actorId: text("actor_id").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** What filters match the event on: its message after the change, and before it. */
    facets: text("facets", { mode: "json" }).$type<EventFacets>(),
    createdAt: createdAt(),
  },
  (t) => [
    // The optimistic lock. A write computed from a stale thread reuses a version,
    // violates this index, and takes its whole batch down with it.
    uniqueIndex("events_thread_version").on(t.threadId, t.threadVersion),
    index("events_vibe_seq").on(t.vibeId, t.seq),
    index("events_message").on(t.messageId),
  ],
);

// ── Tasks ────────────────────────────────────────────────────────────────────

export const tasks = sqliteTable(
  "tasks",
  {
    /** The ID of the thread's root message. A task is a thread. */
    id: text("id").primaryKey(),
    vibeId: text("vibe_id").notNull(),
    channel: text("channel").notNull(),
    /** The actor that made the thread a task. */
    owner: text("owner").notNull(),
    /** The principal behind `owner`: whose tasks a worker takes by default. */
    ownerPrincipal: text("owner_principal").notNull(),
    state: text("state", {
      enum: ["waiting", "ready", "claimed", "blocked", "completed", "failed", "canceled"],
    }).notNull(),
    /** The one profile of the owner's principal that can claim it. */
    assignee: text("assignee"),
    claimId: text("claim_id"),
    claimedBy: text("claimed_by"),
    /** When the claim's lease runs out. Past it, the task counts as ready whatever `state` says. */
    leaseExpiresAt: integer("lease_expires_at"),
    holdKind: text("hold_kind"),
    holdReason: text("hold_reason"),
    result: text("result"),
    reason: text("reason"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // The queue: a vibe's tasks in a state, oldest first.
    index("tasks_queue").on(t.vibeId, t.state, t.createdAt),
    // What the sweep reads: claims whose lease has run out.
    index("tasks_lease").on(t.state, t.leaseExpiresAt),
  ],
);

export const taskNeeds = sqliteTable(
  "task_needs",
  {
    taskId: text("task_id").notNull(),
    /** A task that must complete first. */
    needsId: text("needs_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.needsId] }),
    // What waits for a task, read when it completes.
    index("task_needs_needed").on(t.needsId),
  ],
);

// ── Automation ───────────────────────────────────────────────────────────────

/** A post to make later, once or at an interval, as whoever scheduled it. */
export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    vibeId: text("vibe_id").notNull(),
    /** Where it posts: the channel named, or the channel of the thread it replies in. */
    channel: text("channel").notNull(),
    /** The root of the thread it replies in. `null` when each firing starts a thread. */
    threadId: text("thread_id"),
    /** The exact message it answers, when that isn't the thread's root. */
    replyTo: text("reply_to"),
    /** Who scheduled it, and so who each post is by. */
    actorId: text("actor_id").notNull(),
    principal: text("principal").notNull(),
    profile: text("profile"),
    text: text("text").notNull(),
    labels: text("labels", { mode: "json" }).$type<Record<string, string>>().notNull(),
    /** The data each post carries, as it was given: a schema's ID and an object. */
    blocks: text("blocks", { mode: "json" })
      .$type<{ schema: string; data: Record<string, unknown> }[]>()
      .notNull(),
    state: text("state", { enum: ["pending", "done", "canceled", "stopped"] }).notNull(),
    /** When it fires next, while it is pending. Afterwards, when it last was to. */
    nextAt: integer("next_at").notNull(),
    /** The interval it repeats at, in milliseconds. `null` for a single post. */
    every: integer("every"),
    /** No firing after this time. */
    until: integer("until"),
    /** How many firings are left, when it was given a number of them. */
    remaining: integer("remaining"),
    /** How many times it has fired. Each firing posts under a key made from this. */
    runs: integer("runs").notNull().default(0),
    lastRunAt: integer("last_run_at"),
    lastMessageId: text("last_message_id"),
    /** Why it stopped, as an error code, when a firing was refused. */
    reason: text("reason"),
    /** Each post is kept off every synced platform. */
    noSync: integer("no_sync", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // What the scheduler reads each minute: what is pending and due.
    index("schedules_due").on(t.state, t.nextAt),
    index("schedules_vibe").on(t.vibeId, t.state, t.createdAt),
    index("schedules_thread").on(t.threadId),
  ],
);

/** A URL that Vibe posts a vibe's matching events to, as they are written. */
export const watchers = sqliteTable(
  "watchers",
  {
    id: text("id").primaryKey(),
    vibeId: text("vibe_id").notNull(),
    /** Its name in the vibe, and the profile it writes as: what it writes under that name never wakes it. */
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** What it follows: the filters of `vibe tail`, settled when it was registered. */
    tail: text("tail", { mode: "json" })
      .$type<{
        channel: string;
        re: string | null;
        by: string | null;
        labels: string[];
        mentions: string | null;
        /** Absent on a watcher made before there was sync. */
        source?: string | null;
        all: boolean;
      }>()
      .notNull(),
    /** Signs each delivery. Shown once to whoever registered it, and kept: signing needs it. */
    secret: text("secret").notNull(),
    /** Who registered it. */
    actorId: text("actor_id").notNull(),
    /** Whose access it reads with, checked again at each delivery. */
    principal: text("principal").notNull(),
    state: text("state", { enum: ["active", "stopped"] }).notNull(),
    /** Why it stopped, as an error code. */
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("watchers_vibe_name").on(t.vibeId, t.name)],
);

/**
 * How far each watcher has got in its vibe's event log, and how its deliveries
 * are going. The cursor is the record of what was delivered: whatever asks for
 * a delivery, a queue or a timer, may be lost or repeated without losing an event.
 */
export const watcherCursors = sqliteTable("watcher_cursors", {
  watcherId: text("watcher_id").primaryKey(),
  /** The last event it was delivered, or was spared because it didn't match. */
  seq: integer("seq").notNull(),
  /** Failed attempts at the delivery it is stuck on. 0 once one goes through. */
  attempts: integer("attempts").notNull().default(0),
  /** No attempt before this time: the wait after a failed one. */
  retryAt: integer("retry_at"),
  /** Held by one delivery pass until this time, so two never post for it at once. */
  leasedUntil: integer("leased_until"),
  /** What the endpoint answered last, when it answered. */
  lastStatus: integer("last_status"),
  lastError: text("last_error"),
  deliveredAt: integer("delivered_at"),
  updatedAt: integer("updated_at").notNull(),
});

// ── Sync ─────────────────────────────────────────────────────────────────────

/** How one platform channel is mapped: a Slack channel, a GitHub repository or a Linear team. */
export interface SyncMapping {
  /** The platform's own name for it, which survives a rename: `C0123ABC`, `acme/www`, a team's ID. */
  platform: string;
  /** How people write it: `#errors`, `acme/www`, `ENG`. */
  label: string;
  /** The vibe channel it syncs with. */
  channel: string;
  /** On GitHub, which of a repository's two kinds of thread this row is for. Both, when left out. */
  only?: "pulls" | "issues";
  /** Whether what is written on the vibe goes out to it. */
  out: boolean;
}

/** A sync entry's settings: what it maps, and what the platform said of the credentials it holds. */
export interface SyncConfig {
  mappings: SyncMapping[];
  /** Where the platform's API is reached. */
  api: string;
  /** Who the credentials act as on the platform, by the platform's IDs: how its own writes are told apart. */
  self: Record<string, string>;
  /** Whether a message can go out under its author's name, where the platform has to allow that. */
  customize: boolean;
}

/**
 * A sync entry: one platform account, the channels of it that sync with this
 * vibe's channels, and the service it acts as here.
 */
export const syncSources = sqliteTable(
  "sync_sources",
  {
    id: text("id").primaryKey(),
    vibeId: text("vibe_id").notNull(),
    /** Its name in the vibe, such as `slack`: what a target, a `--source` filter and a message's `from` say. */
    key: text("key").notNull(),
    platform: text("platform", { enum: ["slack", "github", "linear"] }).notNull(),
    /** The service it reads and writes as. Platform users are shown through it. */
    principal: text("principal").notNull(),
    config: text("config", { mode: "json" }).$type<SyncConfig>().notNull(),
    /** The platform's credentials, sealed with the deployment's key. Never returned. */
    credentials: text("credentials").notNull(),
    state: text("state", { enum: ["active", "stopped"] }).notNull(),
    /** Why it stopped, as an error code. */
    reason: text("reason"),
    /** The actor that created it. */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sync_sources_vibe_key").on(t.vibeId, t.key)],
);

/**
 * How far each sync entry has read in its vibe's event log. Reading an event
 * only plans its deliveries, in the same commit that moves the cursor, so a
 * platform that is down never holds the cursor back.
 */
export const syncCursors = sqliteTable("sync_cursors", {
  sourceId: text("source_id").primaryKey(),
  seq: integer("seq").notNull(),
  /** Held by one pass until this time, so two never deliver for one entry at once. */
  leasedUntil: integer("leased_until"),
  updatedAt: integer("updated_at").notNull(),
});

/** A vibe thread that syncs with a thread on a platform, through one sync entry. */
export const syncThreads = sqliteTable(
  "sync_threads",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    vibeId: text("vibe_id").notNull(),
    /** The vibe thread, by its root. */
    threadId: text("thread_id").notNull(),
    /** The platform channel the thread is in: a Slack channel's ID, `owner/repo`, a Linear team's ID. */
    platformChannel: text("platform_channel").notNull(),
    /**
     * The platform's thread: `C0123:1700000000.000100`, `acme/www#12`, an
     * issue's ID. `null` until the vibe thread's root has been delivered and
     * the platform has said what it made of it.
     */
    platformThread: text("platform_thread"),
    /** The platform's link to it. */
    url: text("url"),
    /** Where the vibe's log stood when the two were joined. What was written after goes out. */
    sinceSeq: integer("since_seq").notNull(),
    /** `failed` once the thread could not be started on the platform. */
    state: text("state", { enum: ["active", "failed"] }).notNull(),
    /** The actor that joined them. */
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // A platform thread syncs with one vibe thread only. Of two that try to
    // take it, the second commit fails as a whole.
    uniqueIndex("sync_threads_platform").on(t.sourceId, t.platformThread),
    index("sync_threads_thread").on(t.threadId),
  ],
);

/**
 * Which vibe message is which platform message, in one synced thread, and for
 * a message on its way out, how its delivery is going.
 */
export const syncMessages = sqliteTable(
  "sync_messages",
  {
    syncThreadId: text("sync_thread_id").notNull(),
    messageId: text("message_id").notNull(),
    sourceId: text("source_id").notNull(),
    /** `in` for a message that came from the platform, `out` for the copy of one that didn't. */
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    /** The platform's message: `C0123:1700000000.000200`, `ic:123`, a comment's ID. `null` until it is there. */
    platformMessage: text("platform_message"),
    url: text("url"),
    state: text("state", { enum: ["pending", "done", "failed", "skipped"] }).notNull(),
    /** The place of the event that posted the message: the order copies go out in. */
    seq: integer("seq").notNull(),
    /** Attempts that failed. */
    attempts: integer("attempts").notNull().default(0),
    /** No attempt before this time: the wait after a failed one. */
    retryAt: integer("retry_at"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    // One copy of a message in a platform thread, however often it is planned.
    primaryKey({ columns: [t.syncThreadId, t.messageId] }),
    // A platform message comes in once, however often its webhook is sent.
    uniqueIndex("sync_messages_platform").on(t.sourceId, t.platformMessage),
    // What a pass delivers next.
    index("sync_messages_due").on(t.sourceId, t.state, t.seq),
    index("sync_messages_message").on(t.messageId),
  ],
);

/** The raw events a sync entry received from its platform, the newest few hundred of them. */
export const syncInbox = sqliteTable(
  "sync_inbox",
  {
    sourceId: text("source_id").notNull(),
    /** The platform's ID for the delivery: what a repeated webhook repeats. */
    deliveryId: text("delivery_id").notNull(),
    /** What kind of event it is, in the platform's words. */
    event: text("event").notNull(),
    /** The body as it arrived, cut short when it is long. */
    body: text("body").notNull(),
    state: text("state", { enum: ["received", "done", "ignored", "failed"] }).notNull(),
    /** What was made of it: why it was ignored, or how it failed. */
    note: text("note"),
    receivedAt: integer("received_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.deliveryId] }),
    index("sync_inbox_recent").on(t.sourceId, t.receivedAt),
  ],
);
