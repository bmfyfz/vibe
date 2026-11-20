import type { ActorDirectory, Authorizer, Caller } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type Clock,
  type EventLog,
  invalid,
  newId,
  parseChannelPath,
  type UnitOfWork,
} from "@vibe/kernel";

import type { Block, BlockInput } from "../domain/block.ts";
import { duplicateId, messageNotFound, writeConflict } from "../domain/errors.ts";
import type { Labels } from "../domain/label.ts";
import type { SettledText } from "../domain/mentions.ts";
import { Thread } from "../domain/thread.ts";
import type { VisibleActors } from "./actors.ts";
import type { Attachments } from "./attachments.ts";
import type { IdempotencyStore, ThreadRepository, VibeRecord } from "./ports.ts";
import { toRecords } from "./records.ts";
import type { Schemas } from "./schemas.ts";

export interface PostMessageCommand {
  caller: Caller;
  vibe: VibeRecord;
  /** Start a thread in this channel. */
  channel?: string | undefined;
  /** Or reply in the thread that holds this message. */
  re?: string | undefined;
  text: string;
  /** Reply only while this message is still the thread's newest. */
  after?: string | undefined;
  idempotencyKey?: string | undefined;
  attachments?: readonly string[] | undefined;
  /** Labels to put on the new message. */
  labels?: Labels | undefined;
  /** Structured data to carry, each block naming the schema it must match. */
  blocks?: readonly BlockInput[] | undefined;
  /** Keep the message off every synced platform. On a thread's root, the whole thread. */
  noSync?: boolean | undefined;
  /**
   * `exact` when the text was written somewhere else: a handle in it mentions
   * no one here, and only `@[actor-id]` does.
   */
  mentions?: "exact" | undefined;
  /**
   * The sync entry the message came in through, by its key. Only the Sync
   * context says so: no request can.
   */
  source?: string | undefined;
  /**
   * What another context writes in the commit that makes the post, so that
   * both land or neither does: Sync records which platform message this is.
   * A constraint its writes break fails the commit, and comes back to the
   * caller as the `ConstraintViolation` it is.
   */
  alongside?: ((uow: UnitOfWork, posted: Posted) => void) | undefined;
}

/** A post as it is about to be committed. */
export interface Posted {
  messageId: string;
  /** The root of the thread it is in: itself, for a post that starts one. */
  threadId: string;
  channel: string;
}

/** Where a post lands: a channel, and when it is a reply, the thread and the message answered. */
export interface PostTarget {
  channel: string;
  /** The root of the thread replied in. `null` for a post that starts a thread. */
  threadId: string | null;
  /** The exact message answered, when that isn't the root. */
  replyTo: string | null;
}

export interface PostMessageResult {
  messageId: string;
  /** `false` when the idempotency key matched an earlier post. */
  created: boolean;
  /** What the text wrote as a mention that settled on no one, and stayed plain text. */
  unresolved: readonly string[];
}

// Each attempt loads fresh state, decides again, and commits. A commit that
// loses a race writes nothing, so trying again is always safe.
const MAX_ATTEMPTS = 8;

export class PostMessage {
  constructor(
    private readonly threads: ThreadRepository,
    private readonly attachments: Attachments,
    private readonly idempotency: IdempotencyStore,
    private readonly eventLog: EventLog,
    private readonly authorizer: Authorizer,
    private readonly actors: ActorDirectory,
    private readonly visible: VisibleActors,
    private readonly schemas: Schemas,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: PostMessageCommand): Promise<PostMessageResult> {
    const { threads, idempotency, eventLog, actors, begin, clock } = this;
    assertTarget(command);

    const earlier = await this.replay(command);
    if (earlier) return earlier;
    const settled = await this.visible.settle(
      command.caller,
      command.vibe,
      command.text,
      command.mentions,
    );
    // Checked once: a registered schema never changes, so a retry can't decide otherwise.
    const blocks = await this.schemas.settle(command.vibe.teamId, command.blocks ?? []);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const meanwhile = await this.replay(command);
        if (meanwhile) return meanwhile;
      }

      const now = clock.now();
      const messageId = newId("msg", now);
      const thread = await this.decide(command, settled, blocks, messageId, now);
      const events = thread.pullEvents();

      const uow = begin();
      // The event insert carries the thread's version, so it is the statement
      // that fails when another writer got there first.
      eventLog.append(uow, toRecords(thread, events));
      threads.save(uow, thread, events);
      actors.introduce(uow, command.caller, now);
      command.alongside?.(uow, {
        messageId,
        threadId: thread.id,
        channel: thread.snapshot.channel,
      });
      if (command.idempotencyKey !== undefined) {
        idempotency.record(uow, {
          principal: command.caller.principal,
          key: command.idempotencyKey,
          target: targetOf(command.vibe, thread, command),
          messageId,
          createdAt: now,
        });
      }

      try {
        await uow.commit();
        return { messageId, created: true, unresolved: settled.unresolved };
      } catch (error) {
        // All three mean "the world moved": someone advanced the thread, used
        // the same key, or attached the same file. The next attempt sees it and
        // either succeeds or fails with the reason.
        const lostRace =
          eventLog.isVersionConflict(error) ||
          idempotency.isDuplicate(error) ||
          threads.isAttachmentTaken(error);
        if (!lostRace) throw error;
      }
    }
    throw writeConflict();
  }

  /**
   * Decides a post without making it: whether this caller could post this,
   * there, as things stand. For a context that posts later on the caller's
   * behalf, and should refuse now what would be refused then.
   *
   * @returns Where the post would land.
   * @throws What `execute` would, short of a lost race.
   */
  async rehearse(command: PostMessageCommand): Promise<PostTarget> {
    assertTarget(command);
    const settled = await this.visible.settle(
      command.caller,
      command.vibe,
      command.text,
      command.mentions,
    );
    const blocks = await this.schemas.settle(command.vibe.teamId, command.blocks ?? []);
    const now = this.clock.now();
    const thread = await this.decide(command, settled, blocks, newId("msg", now), now);
    const { channel } = thread.snapshot;
    if (command.re === undefined) return { channel, threadId: null, replyTo: null };
    return { channel, threadId: thread.id, replyTo: command.re === thread.id ? null : command.re };
  }

  /** Returns the earlier post when this request repeats one, so a retry posts once. */
  private async replay(command: PostMessageCommand): Promise<PostMessageResult | null> {
    if (command.idempotencyKey === undefined) return null;
    const { caller, vibe } = command;
    const entry = await this.idempotency.find(caller.principal, command.idempotencyKey);
    if (!entry) return null;

    let thread: Thread | null = null;
    if (command.re !== undefined) {
      thread = await this.load(vibe, command.re);
      // Before anything is said about the key: a thread the caller can't read
      // is not there, whether or not the key was used.
      const resource = { vibeId: vibe.id, channel: thread.snapshot.channel };
      const can = await this.authorizer.permissions(caller, resource);
      if (!can.has("read")) throw messageNotFound(command.re);
    } else if (caller.narrowed !== null) {
      // A key belongs to the principal. A caller under a limit gets back only
      // what it could have posted itself, not its principal's posts elsewhere.
      const channel = parseChannelPath(command.channel ?? "");
      await this.authorizer.require(caller, "post", { vibeId: vibe.id, channel });
    }
    if (entry.target !== targetOf(vibe, thread, command)) throw duplicateId();
    return { messageId: entry.messageId, created: false, unresolved: [] };
  }

  /** Runs the domain rules against fresh state, and returns the thread with its changes pending. */
  private async decide(
    command: PostMessageCommand,
    settled: SettledText,
    blocks: readonly Block[],
    messageId: string,
    now: number,
  ): Promise<Thread> {
    const { caller, vibe } = command;
    const { authorizer } = this;
    const message = {
      id: messageId,
      actorId: caller.actorId,
      text: settled.text,
      attachmentIds: command.attachments,
      blocks,
      labels: command.labels,
      mentions: settled.mentions,
      source: command.source,
      noSync: command.noSync,
      now,
    };
    const labelled = Object.keys(command.labels ?? {}).length > 0;

    let thread: Thread;
    if (command.re === undefined) {
      const channel = parseChannelPath(command.channel ?? "");
      const resource = { vibeId: vibe.id, channel };
      await authorizer.require(caller, "post", resource);
      if (labelled) await authorizer.require(caller, "label", resource);
      thread = Thread.start({ ...message, vibeId: vibe.id, channel });
    } else {
      thread = await this.load(vibe, command.re);
      const resource = { vibeId: vibe.id, channel: thread.snapshot.channel };
      const can = await authorizer.permissions(caller, resource);
      // A reply takes both: you answer what you can read. A thread the caller
      // can't read is, to them, not there.
      if (!can.has("read")) throw messageNotFound(command.re);
      if (!can.has("post")) await authorizer.require(caller, "post", resource);
      if (labelled && !can.has("label")) await authorizer.require(caller, "label", resource);
      thread.reply({ ...message, inReplyTo: command.re, after: command.after });
    }

    await this.attachments.assertPostable(caller, vibe, command.attachments ?? []);
    return thread;
  }

  private async load(vibe: VibeRecord, messageId: string): Promise<Thread> {
    const thread = await this.threads.findByMessage(vibe.id, messageId);
    if (!thread) throw messageNotFound(messageId);
    return thread;
  }
}

function assertTarget(command: PostMessageCommand): void {
  if ((command.channel === undefined) === (command.re === undefined)) {
    throw invalid(
      "invalid_request",
      "Pass exactly one of `channel`, to start a thread, or `re`, to reply in one.",
    );
  }
}

function targetOf(vibe: VibeRecord, thread: Thread | null, command: PostMessageCommand): string {
  return command.re === undefined
    ? `${vibe.id}:channel:${command.channel}`
    : `${vibe.id}:thread:${thread?.id}`;
}
