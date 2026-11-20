import type { ActorDirectory, Authorizer, Grants } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type BlobStore,
  type Clock,
  type EventLog,
  systemClock,
} from "@vibe/kernel";
import type { Db } from "@vibe/store";

import { VisibleActors } from "./application/actors.ts";
import { Attachments } from "./application/attachments.ts";
import { ChangeMessage } from "./application/change-message.ts";
import { Channels } from "./application/channels.ts";
import { ThreadFollowers } from "./application/followers.ts";
import type { IdempotencyStore, MessagingQueries, ThreadRepository } from "./application/ports.ts";
import { PostMessage } from "./application/post-message.ts";
import { Schemas } from "./application/schemas.ts";
import { Vibes } from "./application/vibes.ts";
import { DrizzleMessagingQueries } from "./infrastructure/drizzle-queries.ts";
import {
  DrizzleAttachmentRepository,
  DrizzleChannelRepository,
  DrizzleIdempotencyStore,
  DrizzleSchemaRepository,
  DrizzleThreadRepository,
  DrizzleVibeRepository,
} from "./infrastructure/drizzle-repositories.ts";
import { JsonSchemaChecker } from "./infrastructure/json-schema-checker.ts";

export type { OpenedAttachment, UploadCommand } from "./application/attachments.ts";
export type {
  ChangeMessage,
  ChangeResult,
  DeleteMessageCommand,
  EditMessageCommand,
  LabelMessageCommand,
  ReactCommand,
} from "./application/change-message.ts";
export type { Attachments } from "./application/attachments.ts";
export type { VisibleActors } from "./application/actors.ts";
export type { CreateChannelCommand, CreatedChannel } from "./application/channels.ts";
export type {
  Alongside,
  ThreadChange,
  ThreadFollower,
  ThreadFollowers,
} from "./application/followers.ts";
export type {
  IdempotencyStore,
  MessagingQueries,
  VibeRecord,
  ThreadFilter,
  ThreadRepository,
} from "./application/ports.ts";
export { toRecords } from "./application/records.ts";
export type { RegisterSchemaCommand, Schemas } from "./application/schemas.ts";
export type { Block, BlockInput } from "./domain/block.ts";
export { MAX_BLOCKS, MAX_BLOCKS_BYTES } from "./domain/block.ts";
export { type Schema, schemaId } from "./domain/schema.ts";
export { messageDeleted, messageNotFound, writeConflict } from "./domain/errors.ts";
export { Thread, type ThreadEvent } from "./domain/thread.ts";
export type {
  Posted,
  PostMessage,
  PostMessageCommand,
  PostMessageResult,
  PostTarget,
} from "./application/post-message.ts";
export type { Vibes } from "./application/vibes.ts";
export { normalizeEmoji } from "./domain/emoji.ts";
export type { LabelChange, Labels } from "./domain/label.ts";
export { MAX_LABEL_VALUE_BYTES, MAX_LABELS, RESERVED_LABEL_PREFIX } from "./domain/label.ts";
export { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_TEXT_LENGTH } from "./domain/message.ts";
export { DEFAULT_VIBE } from "./domain/vibe.ts";
// The message view, shared with the event feed, which shows messages too.
export {
  type ActorRow,
  actorFields,
  cameFrom,
  type MessageRow,
  messageFields,
  toActor,
  toMessage,
  WRITTEN_HERE,
  wroteAs,
} from "./infrastructure/views.ts";

export interface Messaging {
  vibes: Vibes;
  channels: Channels;
  postMessage: PostMessage;
  changeMessage: ChangeMessage;
  attachments: Attachments;
  /** The team's registry of schemas for structured data. */
  schemas: Schemas;
  actors: VisibleActors;
  queries: MessagingQueries;
  /** What a context that keeps state on threads builds on: see the tasks context. */
  threads: ThreadRepository;
  idempotency: IdempotencyStore;
  followers: ThreadFollowers;
}

/** Wires the Messaging context to a database, a blob store, the event log and the access check. */
export function createMessaging(deps: {
  db: Db;
  begin: BeginUnitOfWork;
  blobs: BlobStore;
  eventLog: EventLog;
  authorizer: Authorizer;
  actors: ActorDirectory;
  grants: Grants;
  clock?: Clock | undefined;
}): Messaging {
  const clock = deps.clock ?? systemClock;
  const attachments = new DrizzleAttachmentRepository(deps.db);
  const threads = new DrizzleThreadRepository(deps.db);
  const queries = new DrizzleMessagingQueries(deps.db);
  const actors = new VisibleActors(queries, deps.authorizer);
  const files = new Attachments(attachments, deps.blobs, deps.authorizer, clock);
  const idempotency = new DrizzleIdempotencyStore(deps.db);
  const followers = new ThreadFollowers();
  const schemas = new Schemas(
    new DrizzleSchemaRepository(deps.db),
    new JsonSchemaChecker(),
    deps.authorizer,
    deps.actors,
    deps.begin,
    clock,
  );
  return {
    vibes: new Vibes(new DrizzleVibeRepository(deps.db), clock),
    channels: new Channels(
      new DrizzleChannelRepository(deps.db),
      deps.grants,
      deps.eventLog,
      deps.authorizer,
      deps.actors,
      deps.begin,
      clock,
    ),
    postMessage: new PostMessage(
      threads,
      files,
      idempotency,
      deps.eventLog,
      deps.authorizer,
      deps.actors,
      actors,
      schemas,
      deps.begin,
      clock,
    ),
    changeMessage: new ChangeMessage(
      threads,
      deps.eventLog,
      deps.authorizer,
      deps.actors,
      actors,
      followers,
      schemas,
      deps.begin,
      clock,
    ),
    attachments: files,
    schemas,
    actors,
    queries,
    threads,
    idempotency,
    followers,
  };
}
