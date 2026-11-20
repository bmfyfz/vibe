import type { ActorDirectory, Authorizer, Caller, Permission } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type Clock,
  DomainError,
  type EventLog,
  invalid,
} from "@vibe/kernel";

import type { BlockInput } from "../domain/block.ts";
import { messageNotFound, writeConflict } from "../domain/errors.ts";
import type { LabelChange } from "../domain/label.ts";
import type { Thread } from "../domain/thread.ts";
import type { VisibleActors } from "./actors.ts";
import type { ThreadFollowers } from "./followers.ts";
import type { ThreadRepository, VibeRecord } from "./ports.ts";
import { toRecords } from "./records.ts";
import type { Schemas } from "./schemas.ts";

interface MessageCommand {
  caller: Caller;
  vibe: VibeRecord;
  messageId: string;
}

export interface LabelMessageCommand extends MessageCommand {
  change: LabelChange;
}

export interface EditMessageCommand extends MessageCommand {
  /** The new text. Leave it out to keep the text and change only the data. */
  text?: string | undefined;
  /** The new data, in place of what the message carries. Leave it out to keep that. */
  blocks?: readonly BlockInput[] | undefined;
  /** Edit only while the message is still at this revision. */
  revision?: number | undefined;
  /** `exact` when the text was written somewhere else: a handle in it mentions no one here. */
  mentions?: "exact" | undefined;
}

export interface DeleteMessageCommand extends MessageCommand {
  /** Delete only while the message is still at this revision. */
  revision?: number | undefined;
}

export interface ReactCommand extends MessageCommand {
  emoji: string;
  remove?: boolean | undefined;
}

export interface ChangeResult {
  /** `false` when the message already was as asked, so nothing was written. */
  changed: boolean;
}

// Each attempt loads fresh state, decides again, and commits. A commit that
// loses a race writes nothing, so trying again is always safe.
const MAX_ATTEMPTS = 8;

/** The changes to a message that is already in a thread. */
export class ChangeMessage {
  constructor(
    private readonly threads: ThreadRepository,
    private readonly eventLog: EventLog,
    private readonly authorizer: Authorizer,
    private readonly actors: ActorDirectory,
    private readonly visible: VisibleActors,
    private readonly followers: ThreadFollowers,
    private readonly schemas: Schemas,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** Sets and removes labels. With conditions, the check and the change are one write. */
  label(command: LabelMessageCommand): Promise<ChangeResult> {
    const { caller, messageId, change } = command;
    return this.change(command, "label", (thread, now) => {
      thread.label({ messageId, actorId: caller.actorId, change, now });
    });
  }

  /** Adds the caller's reaction to a message, or removes it. */
  react(command: ReactCommand): Promise<ChangeResult> {
    const { caller, messageId, emoji, remove } = command;
    return this.change(command, "react", (thread, now) => {
      thread.react({ messageId, actorId: caller.actorId, emoji, remove, now });
    });
  }

  /**
   * Replaces the text of a message the caller wrote, its data, or both. New
   * text has its mentions settled again, and new data is checked against the
   * schemas it names.
   */
  async edit(
    command: EditMessageCommand,
  ): Promise<ChangeResult & { unresolved: readonly string[] }> {
    const { caller, vibe, messageId, revision } = command;
    if (command.text === undefined && command.blocks === undefined) {
      throw invalid("invalid_request", "An edit gives new `text`, new `blocks`, or both.");
    }
    const settled =
      command.text === undefined
        ? undefined
        : await this.visible.settle(caller, vibe, command.text, command.mentions);
    const blocks =
      command.blocks === undefined
        ? undefined
        : await this.schemas.settle(vibe.teamId, command.blocks);
    // With `post` alone a caller can still fix what it posted.
    const result = await this.change(command, "post", (thread, now) => {
      thread.edit({
        messageId,
        by: caller,
        text: settled?.text,
        mentions: settled?.mentions,
        blocks,
        revision,
        now,
      });
    });
    return { ...result, unresolved: settled?.unresolved ?? [] };
  }

  /**
   * Deletes a message the caller wrote, leaving a tombstone. A team owner can
   * also delete what others wrote, where the owner holds `manage`.
   */
  delete(command: DeleteMessageCommand): Promise<ChangeResult> {
    const { caller, messageId, revision } = command;
    return this.change(command, null, (thread, now, can) => {
      // An owner moderates as themselves. Writing as a profile, they are held
      // to what that profile wrote, like anyone's agent.
      const moderator = caller.profile === null && caller.role === "owner" && can.has("manage");
      thread.delete({ messageId, by: caller, moderator, revision, now });
    });
  }

  /**
   * Runs one change against the thread that holds a message, through the
   * thread's version: when another writer gets there first, the commit fails as
   * a whole and the change is decided again from what that writer left.
   */
  private async change(
    command: MessageCommand,
    permission: Permission | null,
    decide: (thread: Thread, now: number, can: ReadonlySet<Permission>) => void,
  ): Promise<ChangeResult> {
    const { threads, eventLog, authorizer, actors, followers, begin, clock } = this;
    const { caller, vibe, messageId } = command;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const thread = await threads.findByMessage(vibe.id, messageId);
      if (!thread) throw messageNotFound(messageId);
      const resource = { vibeId: vibe.id, channel: thread.snapshot.channel };
      const can = await authorizer.permissions(caller, resource);

      // Having written a message is enough to delete it. Not for a caller
      // under a limit: its limit decides where it may write at all, and what
      // its principal wrote elsewhere is not its own to remove.
      const needed = permission ?? (caller.narrowed === null ? null : "post");
      const now = clock.now();
      try {
        if (needed !== null && !can.has(needed)) {
          await authorizer.require(caller, needed, resource);
        }
        decide(thread, now, can);
      } catch (error) {
        // Refusing a change says the message exists. To someone who can't
        // read its channel, it doesn't.
        const refused = error instanceof DomainError && error.kind === "forbidden";
        throw refused && !can.has("read") ? messageNotFound(messageId) : error;
      }
      const changes = thread.pullEvents();
      if (changes.length === 0) return { changed: false };
      // Whoever keeps state on this thread reacts now, in the same commit.
      const alongside = await followers.follow({ thread, events: changes, caller, now });
      const events = [...changes, ...thread.pullEvents()];

      const uow = begin();
      eventLog.append(uow, toRecords(thread, events));
      threads.save(uow, thread, events);
      alongside(uow);
      actors.introduce(uow, caller, now);
      try {
        await uow.commit();
        return { changed: true };
      } catch (error) {
        if (!eventLog.isVersionConflict(error)) throw error;
      }
    }
    throw writeConflict();
  }
}
