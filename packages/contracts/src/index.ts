import { z } from "zod";

import { MAX_TASKS_PER_WRITE, MAX_WAIT_SECONDS } from "./limits.ts";

export { MAX_TASKS_PER_WRITE, MAX_WAIT_SECONDS } from "./limits.ts";

// The published language of the HTTP API: every request and response, as Zod
// schemas with their inferred types. The API validates with them; the SDK and
// the read models are typed by them.

/** A person's place on the team. */
export const PersonRole = z.enum(["owner", "member", "viewer"]);
export type PersonRole = z.infer<typeof PersonRole>;

/** What caps a principal's access: a person's role, or `service` for a service, which has no ceiling but its grants. */
export const Role = z.enum(["owner", "member", "viewer", "service"]);
export type Role = z.infer<typeof Role>;

/** Who wrote something, as the vibe shows them. */
export const Actor = z.object({
  /** The actor ID, such as `vibe:user:u_…` or `vibe:user:u_…+fx`. */
  actor: z.string(),
  handle: z.string(),
  name: z.string(),
  principal: z.string(),
  profile: z.string().nullable(),
});
export type Actor = z.infer<typeof Actor>;

export const ActorsPage = z.object({ actors: z.array(Actor) });
export type ActorsPage = z.infer<typeof ActorsPage>;

export const Attachment = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  size: z.number().int(),
});
export type Attachment = z.infer<typeof Attachment>;

export const Reaction = z.object({
  /** The emoji's normalized name, such as `eyes` or `thumbs_up`. */
  emoji: z.string(),
  /** Who reacted with it, in order. */
  by: z.array(z.object({ actor: z.string(), handle: z.string() })),
});
export type Reaction = z.infer<typeof Reaction>;

/** Structured data on a message, as it is read: checked against its schema when it was written. */
export const Block = z.object({
  /** The schema's name, such as `sandbox`. */
  schema: z.string(),
  version: z.number().int(),
  data: z.record(z.string(), z.unknown()),
});
export type Block = z.infer<typeof Block>;

/** Structured data as it is written: the schema by its ID, such as `sandbox@1`, and the data. */
export const BlockInput = z.object({
  schema: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type BlockInput = z.infer<typeof BlockInput>;

/** The most blocks one message carries. */
export const MAX_BLOCKS = 8;

export const Message = z.object({
  id: z.string(),
  channel: z.string(),
  text: z.string(),
  /** The ID of the thread's root, or `null` when this message is the root. */
  re: z.string().nullable(),
  /** The exact message answered, when that isn't the root. */
  replyTo: z.string().nullable(),
  by: Actor,
  /** Where it was written: `vibe`, or the key of the sync entry it came in through, such as `slack`. */
  from: z.string(),
  /** `true` for a message kept off every synced platform. On a thread's root, the whole thread is. */
  noSync: z.boolean(),
  attachments: z.array(Attachment),
  /** Its structured data, parsed. A program reads this and never parses the text. */
  blocks: z.array(Block),
  /** One value per key, such as `{ state: "open" }`. */
  labels: z.record(z.string(), z.string()),
  /**
   * Who the text mentions. The text holds each as `@[actor-id]`, so a mention
   * keeps pointing at the same actor; show it by the handle given here.
   */
  mentions: z.array(z.object({ actor: z.string(), handle: z.string(), name: z.string() })),
  reactions: z.array(Reaction),
  /** Changes with each edit, and with the delete. Labels and reactions leave it as it is. */
  revision: z.number().int(),
  /** Set on a tombstone: a deleted message, which keeps its place and loses everything else. */
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Message = z.infer<typeof Message>;

export const ThreadSummary = z.object({
  message: Message,
  replies: z.number().int(),
  last: Message.nullable(),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;

export const ThreadsPage = z.object({
  threads: z.array(ThreadSummary),
  /** The point in the event log this read reflects. Pass it as `after` to read what's new. */
  cursor: z.string(),
});
export type ThreadsPage = z.infer<typeof ThreadsPage>;

export const TaskState = z.enum([
  "waiting",
  "ready",
  "claimed",
  "blocked",
  "completed",
  "failed",
  "canceled",
]);
export type TaskState = z.infer<typeof TaskState>;

/** A thread that agents are to do, and the state the vibe keeps for it. */
export const Task = z.object({
  /** The ID of the task's root message. */
  id: z.string(),
  channel: z.string(),
  state: TaskState,
  owner: Actor,
  /** The one profile of the owner that can claim it, or `null` for anyone who can. */
  for: z.string().nullable(),
  claimedBy: Actor.nullable(),
  /** When the holder's lease runs out. */
  leaseExpiresAt: z.string().nullable(),
  /** The tasks it waits for. */
  needs: z.array(z.string()),
  /** Why it is held for a person, while it is blocked. */
  hold: z.object({ kind: z.string(), reason: z.string() }).nullable(),
  result: z.string().nullable(),
  /** Why it failed or was canceled. */
  reason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const ScheduleState = z.enum(["pending", "done", "canceled", "stopped"]);
export type ScheduleState = z.infer<typeof ScheduleState>;

/** A post to make later, once or at an interval, as whoever scheduled it. */
export const Schedule = z.object({
  /** Such as `sch_…`. */
  id: z.string(),
  /** Where it posts: the channel named, or the channel of the thread it replies in. */
  channel: z.string(),
  /** The root of the thread it replies in, or `null` when each firing starts a thread. */
  re: z.string().nullable(),
  text: z.string(),
  labels: z.record(z.string(), z.string()),
  blocks: z.array(BlockInput),
  /** Who scheduled it. Each post is by them, with the access they have when it fires. */
  by: Actor,
  /**
   * `pending` has a firing ahead. `done` has made its last. `canceled` was
   * called off. `stopped` had a firing refused: `reason` says why.
   */
  state: ScheduleState,
  /** When it fires next, while it is pending. */
  nextAt: z.string().nullable(),
  /** The interval it repeats at, in seconds. `null` for a single post. */
  every: z.number().nullable(),
  /** No firing after this time. */
  until: z.string().nullable(),
  /** How many firings are left, when it was given a number of them. */
  remaining: z.number().int().nullable(),
  /** How many times it has fired. */
  runs: z.number().int(),
  lastRunAt: z.string().nullable(),
  /** What it posted last. */
  lastMessageId: z.string().nullable(),
  /** Why it stopped, as an error code such as `forbidden`. */
  reason: z.string().nullable(),
  /** `true` when each post is kept off every synced platform. */
  noSync: z.boolean(),
  createdAt: z.string(),
});
export type Schedule = z.infer<typeof Schedule>;

export const ThreadDetail = z.object({
  message: Message,
  replies: z.array(Message),
  /** The thread's task, when it is one. */
  task: Task.nullable(),
  /** The pending schedules that will reply in this thread. */
  schedules: z.array(Schedule),
  /** Where the thread is synced, and which deliveries failed. `null` from a Vibe that has no sync. */
  sync: z.lazy(() => SyncedView).nullable(),
  cursor: z.string(),
});
export type ThreadDetail = z.infer<typeof ThreadDetail>;

/** The most platform targets one post names. */
export const MAX_SYNC_TARGETS = 4;

export const ThreadsQuery = z.object({
  channel: z.string().optional(),
  by: z.string().optional(),
  /** Mentioning this actor: a handle, an actor ID, or `me`. */
  mentions: z.string().optional(),
  /** From a source: a sync entry's key, such as `slack`, or `vibe`. */
  source: z.string().optional(),
  after: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ThreadsQuery = z.infer<typeof ThreadsQuery>;

export const PostMessageRequest = z
  .object({
    /** Start a thread in this channel. */
    channel: z.string().optional(),
    /** Or reply in the thread that holds this message. */
    re: z.string().optional(),
    text: z.string().default(""),
    /** Reply only while this message is still the thread's newest. */
    after: z.string().optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
    /** IDs of files this caller uploaded. */
    attachments: z.array(z.string()).optional(),
    /** Labels to put on the new message. */
    labels: z.record(z.string(), z.string()).optional(),
    /** Structured data to carry. Each block must match the schema it names. */
    blocks: z.array(BlockInput).max(MAX_BLOCKS).optional(),
    /** Keep the message off every synced platform. On a thread's root, the whole thread. */
    noSync: z.boolean().optional(),
    /**
     * On a new thread: synced platform targets the thread also starts in or
     * joins, such as `slack:#incidents`. It takes `sync` in the channel.
     */
    sync: z.array(z.string().min(1).max(300)).max(MAX_SYNC_TARGETS).optional(),
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: "Pass exactly one of `channel`, to start a thread, or `re`, to reply in one.",
  })
  .refine((body) => !(body.noSync === true && (body.sync?.length ?? 0) > 0), {
    message: "A message is synced or kept off every platform, not both: drop `sync` or `noSync`.",
  })
  .refine((body) => body.re === undefined || (body.sync?.length ?? 0) === 0, {
    message:
      "`sync` goes with a new thread. To sync a thread that exists, use POST /threads/:id/sync.",
  });
export type PostMessageRequest = z.input<typeof PostMessageRequest>;

export const PostMessageResponse = z.object({
  message: Message,
  /** `false` when an idempotency key matched an earlier post, which is returned as it is. */
  created: z.boolean(),
  /**
   * What the text wrote as a mention that settled on no one you can see, such
   * as `@nobody`. It stayed plain text. A mention never makes a write fail.
   */
  unresolved: z.array(z.string()),
});
export type PostMessageResponse = z.infer<typeof PostMessageResponse>;

export const LabelsRequest = z.object({
  /** Labels to set. Setting a key again replaces its value. */
  set: z.record(z.string(), z.string()).optional(),
  /** Keys to remove. */
  unset: z.array(z.string()).optional(),
  /**
   * What the labels must be for the change to happen: a value, or `null` for a
   * key that mustn't be set. Otherwise nothing changes and the call fails with
   * `label_conflict`.
   */
  if: z.record(z.string(), z.string().nullable()).optional(),
});
export type LabelsRequest = z.infer<typeof LabelsRequest>;

export const EditMessageRequest = z
  .object({
    /** The new text. Leave it out to keep the text. */
    text: z.string().optional(),
    /** The new data, in place of what the message carries. Leave it out to keep that. */
    blocks: z.array(BlockInput).max(MAX_BLOCKS).optional(),
    /** Edit only while the message is still at this revision. */
    revision: z.number().int().optional(),
  })
  .refine((body) => body.text !== undefined || body.blocks !== undefined, {
    message: "Pass new `text`, new `blocks`, or both.",
  });
export type EditMessageRequest = z.infer<typeof EditMessageRequest>;

export const DeleteMessageQuery = z.object({
  /** Delete only while the message is still at this revision. */
  revision: z.coerce.number().int().optional(),
});
export type DeleteMessageQuery = z.infer<typeof DeleteMessageQuery>;

export const ChangeMessageResponse = z.object({
  /**
   * The message as the change left it, or `null` when you can't read its
   * channel: `label` or `react` alone lets you make the change, not see it.
   */
  message: Message.nullable(),
  /** `false` when the message already was as asked. */
  changed: z.boolean(),
  /** After an edit: what the new text wrote as a mention that stayed plain text. */
  unresolved: z.array(z.string()).optional(),
});
export type ChangeMessageResponse = z.infer<typeof ChangeMessageResponse>;

export const VibeEvent = z.object({
  cursor: z.string(),
  type: z.string(),
  createdAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
  message: Message.nullable(),
  actor: Actor,
});
export type VibeEvent = z.infer<typeof VibeEvent>;

export const EventsPage = z.object({
  events: z.array(VibeEvent),
  /** Where to continue from. It advances even when nothing matched the filters. */
  cursor: z.string(),
});
export type EventsPage = z.infer<typeof EventsPage>;

export const EventsQuery = z.object({
  channel: z.string().optional(),
  by: z.string().optional(),
  /** Mentioning this actor: a handle, an actor ID, or `me`. */
  mentions: z.string().optional(),
  /** Only events in the thread whose root has this ID. */
  re: z.string().optional(),
  /** Only events about messages from a source: a sync entry's key, such as `slack`, or `vibe`. */
  source: z.string().optional(),
  /** `true` to include the events that only keep the books, such as lease renewals. */
  all: z.enum(["true", "false"]).optional(),
  /** A cursor or a message ID. Omit to start from now. */
  after: z.string().optional(),
  wait: z.coerce.number().min(0).max(MAX_WAIT_SECONDS).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

export const UploadQuery = z.object({
  /** The file's name, as it should be shown and saved. */
  name: z.string().min(1).max(255),
});
export type UploadQuery = z.infer<typeof UploadQuery>;

export const Permission = z.enum(["read", "post", "react", "label", "sync", "manage"]);
export type Permission = z.infer<typeof Permission>;

/**
 * Who a grant names, as a client names them: a person by handle or by ID, a
 * service by name or by ID, or a group.
 */
export const GrantPrincipalInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), handle: z.string().optional(), id: z.string().optional() }),
  z.object({ kind: z.literal("service"), name: z.string().optional(), id: z.string().optional() }),
  /** Every person on the team. */
  z.object({ kind: z.literal("all-users") }),
  /** Every service on the team. */
  z.object({ kind: z.literal("all-services") }),
  /** Everyone that something else already lets in. Alone it lets no one in. */
  z.object({ kind: z.literal("everyone") }),
]);
export type GrantPrincipalInput = z.infer<typeof GrantPrincipalInput>;

export const GrantPrincipal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), id: z.string(), handle: z.string() }),
  z.object({ kind: z.literal("service"), id: z.string(), name: z.string() }),
  z.object({ kind: z.literal("all-users") }),
  z.object({ kind: z.literal("all-services") }),
  z.object({ kind: z.literal("everyone") }),
]);
export type GrantPrincipal = z.infer<typeof GrantPrincipal>;

/**
 * What a grant gives at each channel pattern: an exact channel, a subtree such
 * as `security/`, or `*`. Each takes `all`, `none`, or a list of permissions.
 */
export const CanInput = z.record(
  z.string(),
  z.union([z.literal("all"), z.literal("none"), z.array(Permission)]),
);
export type CanInput = z.infer<typeof CanInput>;

export const Grant = z.object({
  /** Such as `g4`. */
  id: z.string(),
  principals: z.array(GrantPrincipal),
  can: z.record(z.string(), z.array(Permission)),
});
export type Grant = z.infer<typeof Grant>;

export const GrantsPage = z.object({ grants: z.array(Grant) });
export type GrantsPage = z.infer<typeof GrantsPage>;

export const GrantResponse = z.object({ grant: Grant });
export type GrantResponse = z.infer<typeof GrantResponse>;

export const CreateGrantRequest = z.object({
  principals: z.array(GrantPrincipalInput).min(1),
  can: CanInput,
});
export type CreateGrantRequest = z.infer<typeof CreateGrantRequest>;

export const UpdateGrantRequest = z.object({
  add: z.array(GrantPrincipalInput).optional(),
  remove: z.array(GrantPrincipalInput).optional(),
  /** Replaces what the grant gives. */
  can: CanInput.optional(),
});
export type UpdateGrantRequest = z.infer<typeof UpdateGrantRequest>;

export const ExplainRequest = z.object({
  channel: z.string(),
  /** Whose access to explain: a person, by handle. Omit both to explain your own. */
  user: z.string().optional(),
  /** Or a service, by name. */
  service: z.string().optional(),
});
export type ExplainRequest = z.infer<typeof ExplainRequest>;

export const Explanation = z.object({
  channel: z.string(),
  principal: z.object({ id: z.string(), handle: z.string() }),
  role: Role,
  /** The pattern that decides the channel, or `null` when no grant reaches the principal there. */
  pattern: z.string().nullable(),
  /** The grants that decide at that pattern. Tied grants add up. */
  grants: z.array(z.string()),
  /** What those grants give. */
  granted: z.array(Permission),
  /** What is left once the role has capped it. */
  can: z.array(Permission),
});
export type Explanation = z.infer<typeof Explanation>;

export const Channel = z.object({ path: z.string(), createdAt: z.string() });
export type Channel = z.infer<typeof Channel>;

export const ChannelsPage = z.object({ channels: z.array(Channel) });
export type ChannelsPage = z.infer<typeof ChannelsPage>;

export const CreateChannelRequest = z.object({
  path: z.string(),
  /** Close the new channel to everyone but you. */
  private: z.boolean().optional(),
});
export type CreateChannelRequest = z.infer<typeof CreateChannelRequest>;

export const CreateChannelResponse = z.object({
  channel: Channel,
  /** `false` when the channel already existed. */
  created: z.boolean(),
  /** The grants that make a private channel private. */
  grants: z.array(Grant).optional(),
});
export type CreateChannelResponse = z.infer<typeof CreateChannelResponse>;

export const Vibe = z.object({ id: z.string(), name: z.string(), createdAt: z.string() });
export type Vibe = z.infer<typeof Vibe>;

export const VibesPage = z.object({ vibes: z.array(Vibe) });
export type VibesPage = z.infer<typeof VibesPage>;

export const Whoami = z.object({
  actor: Actor,
  role: Role,
  team: z.object({ id: z.string(), name: z.string() }),
  /** The vibe asked about, when one was. */
  vibe: z.object({ id: z.string(), name: z.string() }).optional(),
  /** What you can do there, at each channel pattern that decides something for you. */
  can: z.record(z.string(), z.array(Permission)).optional(),
  /**
   * Set when the caller acts under a limit, as a delegated token does: it has
   * less than its principal, counts as a member at most, and can't change
   * grants, register watchers or mint tokens.
   */
  narrowed: z
    .object({
      /** When the token stops working. `null` for a limit the request itself asked for. */
      expiresAt: z.string().nullable(),
    })
    .optional(),
});
export type Whoami = z.infer<typeof Whoami>;

export const CreateUserRequest = z.object({
  handle: z.string(),
  name: z.string().min(1).max(100).optional(),
  email: z.email().optional(),
  role: PersonRole.optional(),
  /** The login of the GitHub account they will sign in with. */
  github: z.string().optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const LinkGitHubRequest = z.strictObject({
  /** The login of the GitHub account this person signs in with from now on. */
  github: z.string(),
});
export type LinkGitHubRequest = z.infer<typeof LinkGitHubRequest>;

// ── Signing in ───────────────────────────────────────────────────────────────

/** What a device shows its user, to sign in through GitHub's device flow. */
export const DeviceLogin = z.object({
  /** What the device sends back to ask whether the user has approved. */
  deviceCode: z.string(),
  /** What the user types in. */
  userCode: z.string(),
  /** Where they type it. */
  verificationUri: z.string(),
  /** How long the codes last, in seconds. */
  expiresIn: z.number(),
  /** How long to leave between asking, in seconds. */
  interval: z.number(),
});
export type DeviceLogin = z.infer<typeof DeviceLogin>;

export const DeviceLoginTokenRequest = z.strictObject({ deviceCode: z.string().min(1).max(200) });
export type DeviceLoginTokenRequest = z.infer<typeof DeviceLoginTokenRequest>;

export const DeviceLoginResult = z.discriminatedUnion("status", [
  z.object({
    /** The user hasn't approved yet. Ask again after `interval` seconds, when it is given. */
    status: z.literal("pending"),
    interval: z.number().nullable(),
  }),
  z.object({
    status: z.literal("complete"),
    /** A new token of the person who signed in. Shown once. */
    token: z.string(),
    user: z.object({ id: z.string(), handle: z.string(), name: z.string(), role: PersonRole }),
    /** `true` when this sign-in added them to the team. */
    created: z.boolean(),
  }),
]);
export type DeviceLoginResult = z.infer<typeof DeviceLoginResult>;

export const CreateUserResponse = z.object({
  user: z.object({ id: z.string(), handle: z.string(), name: z.string(), role: PersonRole }),
  /** Shown once. Vibe stores only its hash. */
  token: z.string(),
});
export type CreateUserResponse = z.infer<typeof CreateUserResponse>;

// ── Delegated tokens ─────────────────────────────────────────────────────────

/** The longest a delegated token lasts, in seconds. */
export const MAX_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export const CreateTokenRequest = z.strictObject({
  /** The one profile the token writes as, such as an agent's name. */
  profile: z.string(),
  /** The most the token can do at each channel pattern. It gives no more than you have there. */
  can: CanInput,
  /** How long it lasts, in seconds. An hour, when left out. */
  ttl: z.number().optional(),
});
export type CreateTokenRequest = z.infer<typeof CreateTokenRequest>;

export const CreateTokenResponse = z.object({
  /** Such as `dt_…`. */
  id: z.string(),
  /** The secret. Shown once. Vibe stores only its hash. */
  token: z.string(),
  profile: z.string(),
  can: z.record(z.string(), z.array(Permission)),
  expiresAt: z.string(),
});
export type CreateTokenResponse = z.infer<typeof CreateTokenResponse>;

// ── Tokens a principal holds ─────────────────────────────────────────────────

/**
 * A token as whoever holds it is shown it: what it is and what it is for,
 * never its secret, which was shown once when it was minted.
 */
export const HeldToken = z.object({
  /** `tok_…` for a person's or a service's own, `dt_…` for a delegated one. What revoking takes. */
  id: z.string(),
  kind: z.enum(["user", "service", "delegated"]),
  /** What it was minted for, when its minter said: `initial`, `login`, a name of their own. */
  label: z.string().nullable(),
  createdAt: z.string(),
  /** When it ends by itself. `null` for a person's or a service's own, which lasts until revoked. */
  expiresAt: z.string().nullable(),
  /** Set once it is revoked. A list holds only tokens that work. */
  revokedAt: z.string().nullable(),
  /** Whether it is the token this request came with. */
  current: z.boolean(),
  /** For a delegated token: where it works, as whom, and the most it can do. */
  delegated: z
    .object({
      vibe: z.object({ id: z.string(), name: z.string().nullable() }),
      profile: z.string(),
      can: z.record(z.string(), z.array(Permission)),
      /** The ID of the token or the session it was minted with, and ends with. */
      mintedWith: z.string().nullable(),
    })
    .nullable(),
});
export type HeldToken = z.infer<typeof HeldToken>;

export const HeldTokensPage = z.object({ tokens: z.array(HeldToken) });
export type HeldTokensPage = z.infer<typeof HeldTokensPage>;

export const RevokeTokenResponse = z.object({ token: HeldToken });
export type RevokeTokenResponse = z.infer<typeof RevokeTokenResponse>;

// ── Services ─────────────────────────────────────────────────────────────────

/** A machine principal, such as a CI job or a worker, with tokens of its own. */
export const Service = z.object({
  /** Its principal ID, such as `vibe:service:s_…`. */
  id: z.string(),
  /** Its handle: what a grant names, and what a mention writes after `@`. */
  name: z.string(),
  description: z.string().nullable(),
  /** The actor that created it. */
  createdBy: z.string(),
  createdAt: z.string(),
});
export type Service = z.infer<typeof Service>;

export const ServicesPage = z.object({ services: z.array(Service) });
export type ServicesPage = z.infer<typeof ServicesPage>;

export const CreateServiceRequest = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
});
export type CreateServiceRequest = z.infer<typeof CreateServiceRequest>;

export const CreateServiceResponse = z.object({
  service: Service,
  /** The service's first token. Shown once. Vibe stores only its hash. */
  token: z.string(),
});
export type CreateServiceResponse = z.infer<typeof CreateServiceResponse>;

export const ServiceTokenRequest = z.strictObject({
  /** What the token is for, to tell it from the service's others. */
  label: z.string().min(1).max(100).optional(),
});
export type ServiceTokenRequest = z.infer<typeof ServiceTokenRequest>;

export const ServiceTokenResponse = z.object({
  /** Shown once. Vibe stores only its hash. */
  token: z.string(),
});
export type ServiceTokenResponse = z.infer<typeof ServiceTokenResponse>;

export const ServiceResponse = z.object({ service: Service });
export type ServiceResponse = z.infer<typeof ServiceResponse>;

export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ── Tasks ────────────────────────────────────────────────────────────────────

/** A task with its root message: what to do, and where it stands. */
export const TaskDetail = z.object({ task: Task, message: Message });
export type TaskDetail = z.infer<typeof TaskDetail>;

export const TasksPage = z.object({ tasks: z.array(TaskDetail) });
export type TasksPage = z.infer<typeof TasksPage>;

export const TasksQuery = z.object({
  channel: z.string().optional(),
  /** One state, `open` for those still to settle, or `all`. */
  state: z.union([TaskState, z.enum(["open", "all"])]).default("open"),
  /** Owned by this actor: a handle, an actor ID, or `me`. */
  by: z.string().optional(),
  /** Kept for this profile. */
  for: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TasksQuery = z.infer<typeof TasksQuery>;

export const NewTask = z.strictObject({
  /** Names this task for the others in the same write. */
  key: z.string().min(1).max(64).optional(),
  text: z.string(),
  labels: z.record(z.string(), z.string()).optional(),
  /** Tasks to wait for: the ID of one that exists, or `{ key }` for one in this write. */
  needs: z.array(z.union([z.string(), z.strictObject({ key: z.string() })])).optional(),
  /** Keep the task for this profile of yours. */
  for: z.string().optional(),
  attachments: z.array(z.string()).optional(),
});
export type NewTask = z.infer<typeof NewTask>;

export const CreateTasksRequest = z.union([
  z.strictObject({
    channel: z.string(),
    tasks: z.array(NewTask).min(1).max(MAX_TASKS_PER_WRITE),
    idempotencyKey: z.string().min(1).max(180).optional(),
  }),
  // Makes a task of a thread that already exists.
  z.strictObject({
    thread: z.string(),
    needs: z.array(z.string()).optional(),
    for: z.string().optional(),
  }),
]);
export type CreateTasksRequest = z.infer<typeof CreateTasksRequest>;

export const CreateTasksResponse = z.object({
  /** The tasks, in the order they were given. */
  tasks: z.array(TaskDetail),
  created: z.boolean(),
  unresolved: z.array(z.string()),
});
export type CreateTasksResponse = z.infer<typeof CreateTasksResponse>;

/** A lease, in seconds. */
const Lease = z.number().min(1).max(300).optional();

export const ClaimTaskRequest = z.strictObject({
  /** Claim this task. */
  id: z.string().optional(),
  /** Or the oldest ready task in this channel, or subtree such as `work/`. */
  ready: z.string().optional(),
  /** With `ready`: only tasks whose root has every one of these labels. */
  labels: z.array(z.string()).optional(),
  /** With `ready`: also take tasks these actors own. By default a worker takes its own principal's. */
  from: z.array(z.string()).max(10).optional(),
  /** With `ready`: how many seconds to wait for a task to become ready. */
  wait: z.number().min(0).max(MAX_WAIT_SECONDS).optional(),
  lease: Lease,
});
export type ClaimTaskRequest = z.infer<typeof ClaimTaskRequest>;

/** What a worker holds: the task, and the claim to renew and settle it with. */
export const ClaimedTask = TaskDetail.extend({
  claim: z.object({ id: z.string(), expiresAt: z.string() }),
});
export type ClaimedTask = z.infer<typeof ClaimedTask>;

export const ClaimTaskResponse = z.object({
  /** `null` when no task was ready, or none became ready in time. */
  claimed: ClaimedTask.nullable(),
});
export type ClaimTaskResponse = z.infer<typeof ClaimTaskResponse>;

export const RenewTaskRequest = z.strictObject({ claim: z.string(), lease: Lease });
export const ReleaseTaskRequest = z.strictObject({ claim: z.string() });
export const CompleteTaskRequest = z.strictObject({
  claim: z.string(),
  result: z.string().optional(),
});
export const FailTaskRequest = z.strictObject({ claim: z.string(), reason: z.string() });
export const BlockTaskRequest = z.strictObject({
  /** The worker's claim. Without one, the caller must own the task. */
  claim: z.string().optional(),
  reason: z.string(),
  /** What the hold is for, such as `awaiting_approval`. */
  kind: z.string().optional(),
});
export const AssignTaskRequest = z.strictObject({
  /** A profile of the owner, or `null` to return the task to anyone who can claim it. */
  for: z.string().nullable(),
});
export const TaskNeedsRequest = z.strictObject({ needs: z.array(z.string()) });
export const CancelTaskRequest = z.strictObject({ reason: z.string() });

export const RenewTaskResponse = z.object({
  claim: z.object({ id: z.string(), expiresAt: z.string() }),
});
export type RenewTaskResponse = z.infer<typeof RenewTaskResponse>;

// ── Schemas ──────────────────────────────────────────────────────────────────

/** What a piece of structured data holds: a JSON Schema under a name and a version. */
export const Schema = z.object({
  /** Such as `sandbox@1`. */
  id: z.string(),
  name: z.string(),
  version: z.number().int(),
  description: z.string().nullable(),
  /** The JSON Schema, for an object. */
  schema: z.record(z.string(), z.unknown()),
  /** The actor that registered it. */
  createdBy: z.string(),
  createdAt: z.string(),
});
export type Schema = z.infer<typeof Schema>;

export const SchemasPage = z.object({ schemas: z.array(Schema) });
export type SchemasPage = z.infer<typeof SchemasPage>;

export const CreateSchemaRequest = z.strictObject({
  name: z.string(),
  version: z.number().int(),
  description: z.string().optional(),
  schema: z.record(z.string(), z.unknown()),
});
export type CreateSchemaRequest = z.infer<typeof CreateSchemaRequest>;

export const CreateSchemaResponse = z.object({
  schema: Schema,
  /** `false` when this version was already registered with the same definition. */
  created: z.boolean(),
});
export type CreateSchemaResponse = z.infer<typeof CreateSchemaResponse>;

// ── Schedules ────────────────────────────────────────────────────────────────

/** The shortest interval a schedule repeats at, in seconds. The scheduler looks once a minute. */
export const MIN_SCHEDULE_INTERVAL_SECONDS = 60;

export const CreateScheduleRequest = z
  .strictObject({
    /** Start a thread in this channel at each firing. */
    channel: z.string().optional(),
    /** Or reply in the thread that holds this message. */
    re: z.string().optional(),
    text: z.string().default(""),
    labels: z.record(z.string(), z.string()).optional(),
    blocks: z.array(BlockInput).max(MAX_BLOCKS).optional(),
    /** Keep each post off every synced platform. */
    noSync: z.boolean().optional(),
    /** Post once, this many seconds from now. With `every`, the first time. */
    in: z.number().optional(),
    /** Post once at this time, as ISO 8601 with its zone. With `every`, the first time. */
    at: z.string().optional(),
    /** Repeat at this interval, in seconds. */
    every: z.number().optional(),
    /** Repeat for this many seconds, counted from the first post. */
    for: z.number().optional(),
    /** Post this many times in all. */
    times: z.number().optional(),
    /** Repeat until this time, as ISO 8601 with its zone. */
    until: z.string().optional(),
  })
  .refine((body) => (body.channel === undefined) !== (body.re === undefined), {
    message: "Pass exactly one of `channel`, to start threads, or `re`, to reply in one.",
  });
export type CreateScheduleRequest = z.input<typeof CreateScheduleRequest>;

export const ScheduleResponse = z.object({ schedule: Schedule });
export type ScheduleResponse = z.infer<typeof ScheduleResponse>;

export const CancelScheduleResponse = z.object({
  schedule: Schedule,
  /** `false` when the schedule had already ended. */
  canceled: z.boolean(),
});
export type CancelScheduleResponse = z.infer<typeof CancelScheduleResponse>;

export const SchedulesQuery = z.object({
  channel: z.string().optional(),
  /** Scheduled by this actor: a handle, an actor ID, or `me`. */
  by: z.string().optional(),
  /** Only those that reply in the thread that holds this message. */
  re: z.string().optional(),
  /** `true` to include the schedules that are done, canceled or stopped. */
  all: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type SchedulesQuery = z.infer<typeof SchedulesQuery>;

export const SchedulesPage = z.object({ schedules: z.array(Schedule) });
export type SchedulesPage = z.infer<typeof SchedulesPage>;

// ── Watchers ─────────────────────────────────────────────────────────────────

/** What a watcher follows: the filters of `vibe tail`, as they were settled when it was registered. */
export const WatcherTail = z.object({
  /** A channel pattern: `*`, a channel, or a subtree such as `www/`. */
  channel: z.string(),
  /** Only events in the thread whose root has this ID. */
  re: z.string().nullable(),
  /** Only events about messages by this author: a handle or an actor ID. */
  by: z.string().nullable(),
  /** Label filters, such as `state=open|draft`. Every one must match. */
  labels: z.array(z.string()),
  /** Only events about messages that mention this actor, by actor ID. */
  mentions: z.string().nullable(),
  /** Only events about messages from this source: a sync entry's key, or `vibe`. */
  source: z.string().nullable(),
  /** Whether it also gets the events that only keep the books. */
  all: z.boolean(),
});
export type WatcherTail = z.infer<typeof WatcherTail>;

/** A URL that Vibe posts a vibe's matching events to. */
export const Watcher = z.object({
  /** Such as `w_…`. */
  id: z.string(),
  /** Its name in the vibe, and the profile it writes as. What it writes under that name never wakes it. */
  name: z.string(),
  url: z.string(),
  tail: WatcherTail,
  /** Who registered it. It reads with their access, as it stands at each delivery. */
  by: Actor,
  /**
   * `active` is up to date or catching up. `failing` has a delivery its
   * endpoint didn't accept, and waits to try again. `stopped` lost whoever
   * registered it, and gets nothing more.
   */
  state: z.enum(["active", "failing", "stopped"]),
  /** Why it stopped, as an error code. */
  reason: z.string().nullable(),
  /** How far it has got in the vibe's event log. */
  cursor: z.string(),
  /** Failed attempts at the delivery it is stuck on. */
  attempts: z.number().int(),
  /** When it tries again, while it is failing. */
  retryAt: z.string().nullable(),
  /** What its endpoint answered last, when it answered. */
  lastStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  /** When a delivery last went through. */
  deliveredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Watcher = z.infer<typeof Watcher>;

export const WatchersPage = z.object({ watchers: z.array(Watcher) });
export type WatchersPage = z.infer<typeof WatchersPage>;

export const CreateWatcherRequest = z.strictObject({
  name: z.string(),
  /** Where deliveries go: https, or http to the machine Vibe runs on. */
  url: z.string(),
  channel: z.string().optional(),
  re: z.string().optional(),
  /** A handle, an actor ID, or `me`. */
  by: z.string().optional(),
  /** A handle, an actor ID, or `me`. */
  mentions: z.string().optional(),
  labels: z.array(z.string()).optional(),
  /** A sync entry's key, such as `slack`, or `vibe`. */
  source: z.string().optional(),
  all: z.boolean().optional(),
});
export type CreateWatcherRequest = z.infer<typeof CreateWatcherRequest>;

export const CreateWatcherResponse = z.object({
  watcher: Watcher,
  /** Signs each delivery. Shown once: keep it where the receiver can read it. */
  secret: z.string(),
});
export type CreateWatcherResponse = z.infer<typeof CreateWatcherResponse>;

export const WatcherResponse = z.object({ watcher: Watcher });
export type WatcherResponse = z.infer<typeof WatcherResponse>;

/**
 * What Vibe posts to a watcher's URL, as JSON. `Vibe-Signature` signs the
 * body with the watcher's secret, and `Vibe-Delivery` repeats `id`.
 */
export const WatcherDelivery = z.object({
  /** The same for every attempt at delivering this event to this watcher: what to deduplicate on. */
  id: z.string(),
  watcher: z.object({ id: z.string(), name: z.string() }),
  vibe: z.object({ id: z.string(), name: z.string() }),
  event: VibeEvent,
});
export type WatcherDelivery = z.infer<typeof WatcherDelivery>;

// ── Sync ─────────────────────────────────────────────────────────────────────

export const SyncPlatform = z.enum(["slack", "github", "linear"]);
export type SyncPlatform = z.infer<typeof SyncPlatform>;

/** One platform channel a sync entry maps: a Slack channel, a GitHub repository or a Linear team. */
export const SyncMapping = z.object({
  /** The platform channel, as people write it: `#errors`, `acme/www`, `ENG`. */
  platform: z.string(),
  /** The vibe channel it syncs with. */
  channel: z.string(),
  /** On GitHub, which of a repository's threads this is for. `null` for both. */
  only: z.enum(["pulls", "issues"]).nullable(),
  /** Whether what is written on the vibe goes out to it. */
  out: z.boolean(),
});
export type SyncMapping = z.infer<typeof SyncMapping>;

/** A sync entry: a platform account whose channels sync with this vibe's. */
export const SyncSource = z.object({
  /** Such as `src_…`. It is in the URL the platform's webhooks are sent to. */
  id: z.string(),
  /** Its name in the vibe: what a target, a `source` filter and a message's `from` say. */
  key: z.string(),
  platform: SyncPlatform,
  /** The service it reads and writes as. Platform users are shown through it. */
  service: z.object({ id: z.string(), handle: z.string() }),
  /** The channels it maps, among those you can read. */
  mappings: z.array(SyncMapping),
  /** `stopped` when its service is gone: `reason` says why. */
  state: z.enum(["active", "stopped"]),
  reason: z.string().nullable(),
  /** The path the platform's webhooks are sent to, on this Vibe's URL. */
  webhook: z.string(),
  /**
   * Where it reaches the platform's API: everything it sends goes there. The
   * platform's own address, unless whoever made the entry gave another.
   */
  api: z.string(),
  /** How far it has read in the vibe's event log. */
  cursor: z.string(),
  /** Copies on their way to the platform, and copies it gave up on. */
  pending: z.number().int(),
  failed: z.number().int(),
  createdAt: z.string(),
});
export type SyncSource = z.infer<typeof SyncSource>;

export const SyncSourcesPage = z.object({ sources: z.array(SyncSource) });
export type SyncSourcesPage = z.infer<typeof SyncSourcesPage>;

export const SyncSourceResponse = z.object({ source: SyncSource });
export type SyncSourceResponse = z.infer<typeof SyncSourceResponse>;

/** What a platform channel is mapped to: a vibe channel, or on GitHub one for each kind of thread. */
export const SyncMapInput = z.union([
  z.string(),
  z.strictObject({
    channel: z.string().optional(),
    pulls: z.string().optional(),
    issues: z.string().optional(),
    /** On GitHub: send replies written on the vibe back as comments. */
    replies: z.boolean().optional(),
  }),
]);
export type SyncMapInput = z.infer<typeof SyncMapInput>;

export const CreateSyncSourceRequest = z.strictObject({
  key: z.string(),
  platform: SyncPlatform,
  /** The name of the service it acts as. */
  service: z.string(),
  /** Platform channel to vibe channel: `{ "#errors": "errors-www" }`, `{ "acme/www": "dev" }`, `{ "ENG": "dev" }`. */
  map: z.record(z.string(), SyncMapInput).default({}),
  credentials: z.strictObject({
    /** The token the platform's API takes. GitHub needs one only to send replies back. */
    token: z.string().min(1).max(4000).optional(),
    /** The secret the platform signs its webhooks with. */
    secret: z.string().min(1).max(4000),
  }),
  /** Where the platform's API is, when it isn't the usual place: https, or http to the machine Vibe runs on. */
  api: z.string().max(2000).optional(),
});
export type CreateSyncSourceRequest = z.input<typeof CreateSyncSourceRequest>;

export const UpdateSyncCredentialsRequest = z
  .strictObject({
    token: z.string().min(1).max(4000).optional(),
    secret: z.string().min(1).max(4000).optional(),
  })
  .refine((body) => body.token !== undefined || body.secret !== undefined, {
    message: "Give a new `token`, a new `secret`, or both.",
  });
export type UpdateSyncCredentialsRequest = z.infer<typeof UpdateSyncCredentialsRequest>;

/** A platform thread a vibe thread syncs with. */
export const SyncTarget = z.object({
  /** The sync entry's key. */
  source: z.string(),
  platform: SyncPlatform,
  /** The entry's key and the platform thread, such as `slack:C0123:1700000000.000100`. The channel, until the thread is there. */
  target: z.string(),
  /** `starting` until the platform has the thread. `failed` when it could not be started. */
  state: z.enum(["starting", "synced", "failed"]),
  /** The platform's link to the thread. */
  url: z.string().nullable(),
  /** The platform's link to the copy of the message asked about, when it has one there. */
  copy: z.string().nullable(),
});
export type SyncTarget = z.infer<typeof SyncTarget>;

/** A delivery to a platform that was given up on. */
export const SyncFailure = z.object({
  /** The message that didn't arrive. */
  message: z.string(),
  source: z.string(),
  target: z.string(),
  error: z.string().nullable(),
  at: z.string(),
});
export type SyncFailure = z.infer<typeof SyncFailure>;

/** Where a thread is synced. */
export const SyncedView = z.object({
  targets: z.array(SyncTarget),
  /** The deliveries that failed for good, until a later one to the same platform thread goes through. */
  failures: z.array(SyncFailure),
});
export type SyncedView = z.infer<typeof SyncedView>;

export const SyncThreadRequest = z.strictObject({
  /** A sync entry's key and a platform channel or thread, such as `slack:#incidents`. */
  target: z.string().min(1).max(300),
});
export type SyncThreadRequest = z.infer<typeof SyncThreadRequest>;

export const SyncThreadResponse = z.object({
  target: z.string(),
  /** `false` when the thread already synced there. */
  attached: z.boolean(),
});
export type SyncThreadResponse = z.infer<typeof SyncThreadResponse>;

/** One raw event a sync entry received from its platform. */
export const SyncInboxEntry = z.object({
  /** The platform's ID for the delivery. */
  id: z.string(),
  /** What kind of event it is, in the platform's words. */
  event: z.string(),
  /** `done` changed something here. `ignored` didn't: `note` says why. `failed` broke on the way. */
  state: z.enum(["received", "done", "ignored", "failed"]),
  note: z.string().nullable(),
  receivedAt: z.string(),
  /** The body as it arrived, parsed when it is JSON. Long ones are cut short, and stay text. */
  body: z.unknown(),
});
export type SyncInboxEntry = z.infer<typeof SyncInboxEntry>;

export const SyncInboxPage = z.object({ events: z.array(SyncInboxEntry) });
export type SyncInboxPage = z.infer<typeof SyncInboxPage>;

export const SyncInboxQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SyncInboxQuery = z.infer<typeof SyncInboxQuery>;

// ── Signing in from a browser ────────────────────────────────────────────────

/** The ways this Vibe lets a person sign in. */
export const SignInWays = z.object({
  /** Whether it has a GitHub app to sign in through. A token always works. */
  github: z.boolean(),
});
export type SignInWays = z.infer<typeof SignInWays>;

export const Person = z.object({
  id: z.string(),
  handle: z.string(),
  name: z.string(),
  role: PersonRole,
});
export type Person = z.infer<typeof Person>;

export const CreateSessionRequest = z.strictObject({
  /** A token of the person's own. It is used this once, and the browser keeps none of it. */
  token: z.string().min(1).max(200),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

/** A browser's session, as the page is told of it. The secret is in a cookie the page can't read. */
export const BrowserSession = z.object({
  user: Person,
  /** When the session ends by itself. */
  expiresAt: z.string(),
});
export type BrowserSession = z.infer<typeof BrowserSession>;

/** One of a person's sessions, as they are shown it. Its secret is in its browser, and nowhere else. */
export const OpenSession = z.object({
  /** Such as `ses_…`. What ending it takes. */
  id: z.string(),
  createdAt: z.string(),
  /** When it ends by itself. */
  expiresAt: z.string(),
  /** What the browser called itself when it signed in, to tell one session from another. */
  userAgent: z.string().nullable(),
  /** The ID of the token it was opened with, and ends with. `null` when it was opened through GitHub. */
  openedWith: z.string().nullable(),
  /** Whether it is the session this request came with. */
  current: z.boolean(),
});
export type OpenSession = z.infer<typeof OpenSession>;

export const SessionsPage = z.object({ sessions: z.array(OpenSession) });
export type SessionsPage = z.infer<typeof SessionsPage>;

export const EndSessionResponse = z.object({ ended: z.literal(true), id: z.string() });
export type EndSessionResponse = z.infer<typeof EndSessionResponse>;

export const DeviceSessionResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending"), interval: z.number().nullable() }),
  z.object({
    status: z.literal("complete"),
    user: Person,
    expiresAt: z.string(),
    /** `true` when this sign-in added them to the team. */
    created: z.boolean(),
  }),
]);
export type DeviceSessionResult = z.infer<typeof DeviceSessionResult>;
