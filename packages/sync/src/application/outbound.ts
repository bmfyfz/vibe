import type { Message, VibeEvent } from "@vibe/contracts";
import type { Authorizer, Caller } from "@vibe/identity";
import {
  ALL_CHANNELS,
  type BeginUnitOfWork,
  type ChannelScope,
  type Clock,
  newId,
  type UnitOfWork,
} from "@vibe/kernel";
import type { MessagingQueries, VibeRecord } from "@vibe/messaging";

import { describeFailure, PlatformError, retryWait } from "../domain/delivery.ts";
import { platformUserOf } from "../domain/platform-user.ts";
import { labelOf, mappingFor, startsFrom } from "../domain/source.ts";
import { formatTarget, webLink } from "../domain/target.ts";
import type { Contexts, Opened } from "./contexts.ts";
import type { Outgoing } from "./platform.ts";
import type {
  CallerDirectory,
  CursorRepository,
  DeliveryTrigger,
  EventSource,
  PlacedCopy,
  SourceRepository,
  StoredSource,
  SyncedThread,
  SyncRecords,
  VibeDirectory,
} from "./ports.ts";
import type { Receipts } from "./receipts.ts";

/** What one pass over sync entries did. */
export interface SyncReport {
  /** Copies a platform accepted. */
  delivered: number;
  /** Attempts a platform didn't accept. Each waits, and is tried again. */
  retried: number;
  /** Copies given up on, after their retries. */
  failed: number;
  /** Entries ended because the service they act as is gone. */
  stopped: number;
}

// One pass reads this many events of an entry's log, and sends this many
// copies, then asks for another pass: an invocation has only so much to spend.
const READ_BATCH = 50;
const SEND_BATCH = 20;
// How long a pass holds an entry. Renewed before each call to the platform,
// so it only has to outlast one call and the writes around it.
const HOLD_MS = 60_000;

/** What a pass knows of the entry it holds. */
interface Held {
  source: StoredSource;
  vibe: VibeRecord;
  /** The service the entry acts as, as it is now. */
  service: Caller;
  opened: Opened;
  /** Where the service may sync, read when the pass began. */
  syncs: ChannelScope;
  /** Where the entry's service reads. What it can't read, it never sends. */
  reads: ChannelScope;
}

/**
 * What goes out to the platforms. It is driven from the event log, with a
 * cursor per sync entry, in two steps that fail apart:
 *
 * 1. Reading an event plans its copies: a row for each platform thread the
 *    message is to reach, written in the commit that moves the cursor. No
 *    platform is called, so none can hold the cursor back.
 * 2. Each planned copy is then sent. One that fails waits and is tried again,
 *    up to five times, and is then recorded as failed. The copies after it
 *    go out meanwhile.
 *
 * Edits, deletes and reactions are sent once as their events are read, and
 * a platform that refuses one keeps its copy as it was.
 */
export class Deliveries {
  constructor(
    private readonly sources: SourceRepository,
    private readonly cursors: CursorRepository,
    private readonly records: SyncRecords,
    private readonly events: EventSource,
    private readonly messages: MessagingQueries,
    private readonly vibes: VibeDirectory,
    private readonly callers: CallerDirectory,
    private readonly authorizer: Authorizer,
    private readonly contexts: Contexts,
    private readonly receipts: Receipts,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
    private readonly trigger: DeliveryTrigger | undefined,
  ) {}

  /** Asks for a pass when a vibe that syncs has just been written to. The cost to one that doesn't is one small read. */
  async noticed(vibeId: string): Promise<void> {
    if (!this.trigger) return;
    if ((await this.sources.active(vibeId)).length > 0) this.trigger.request(vibeId, 0);
  }

  /** Runs a vibe's sync entries. What a queue or a timer runs after a write. */
  async deliverVibe(vibeId: string): Promise<SyncReport> {
    return this.pass(await this.sources.active(vibeId));
  }

  /**
   * Runs every entry that has something to do, in any vibe. The scheduler
   * runs it each minute, so a prompt that went missing costs a minute at most.
   */
  async deliverDue(limit = 50): Promise<SyncReport> {
    return this.pass(await this.sources.due(this.clock.now(), limit));
  }

  private async pass(sources: readonly StoredSource[]): Promise<SyncReport> {
    const report: SyncReport = { delivered: 0, retried: 0, failed: 0, stopped: 0 };
    for (const source of sources) {
      try {
        await this.run(source, report);
      } catch (error) {
        // Its cursor and its copies are as the last write left them, and its
        // hold runs out by itself: the next pass carries on from there.
        console.error(`Syncing ${source.key} (${source.id}) failed; a later pass retries.`, error);
      }
    }
    return report;
  }

  private async run(source: StoredSource, report: SyncReport): Promise<void> {
    const { cursors, clock } = this;
    if (!this.contexts.available) return;
    // The hold is known by when it ends: only the pass that set that time renews or releases it.
    let hold = clock.now() + HOLD_MS;
    const held = await cursors.lease(source.id, clock.now(), hold);
    if (!held) return;

    const vibe = await this.vibes.find(source.vibeId);
    const service = await this.callers.callerOf(source.principal, null);
    if (!vibe || !service || service.teamId !== vibe.teamId) {
      await this.sources.stop(source.id, "author_not_found");
      report.stopped += 1;
      return;
    }
    const entry: Held = {
      source,
      vibe,
      service,
      opened: await this.contexts.open(source),
      syncs: await this.authorizer.scope(service, vibe.id, "sync"),
      reads: await this.authorizer.scope(service, vibe.id, "read"),
    };

    const { seq, more } = await this.plan(entry, held.seq);
    const sent = await this.send(entry, report, async () => {
      const next = clock.now() + HOLD_MS;
      const kept = await cursors.renew(source.id, hold, next);
      if (kept) hold = next;
      return kept;
    });
    await cursors.release(source.id, hold, clock.now());

    if (!this.trigger) return;
    // More to read, more to send, or something written while this pass held
    // the entry, whose own prompt found it held.
    if (more || sent === SEND_BATCH || (await this.events.place(vibe.id)) > seq) {
      this.trigger.request(vibe.id, 0);
    }
  }

  /**
   * Reads the entry's log from its cursor and plans what each event sends,
   * all in the one commit that moves the cursor past them.
   *
   * @returns Where the cursor stands, and whether a full page may have left more behind it.
   */
  private async plan(entry: Held, from: number): Promise<{ seq: number; more: boolean }> {
    const { source, vibe, service } = entry;
    // The entry reads as its service: what the service can't read, it never sends.
    const page = await this.events.since(vibe.id, from, { channel: ALL_CHANNELS }, READ_BATCH, () =>
      this.authorizer.scope(service, vibe.id),
    );
    if (page.upto === from) return { seq: from, more: false };

    const now = this.clock.now();
    const uow = this.begin();
    // The threads this page starts, which the store doesn't hold until the
    // page commits: a reply read after its root, in the same page, joins them.
    const starting = new Map<string, SyncedThread[]>();
    for (const { place, channel, event } of page.events) {
      const { message } = event;
      if (!message || channel === null || !entry.syncs.allows(channel)) continue;
      if (event.type === "message.posted") {
        await this.planCopies(entry, uow, starting, message, place, now);
      } else {
        // Best effort, and before the cursor moves: a pass that dies here
        // sends the change again, which a platform takes as no change.
        await this.follow(entry, event, message);
      }
    }
    this.cursors.advance(uow, source.id, from, page.upto, now);
    await uow.commit();
    return { seq: page.upto, more: page.events.length === READ_BATCH };
  }

  /** Plans a new message's copies: one for each platform thread its thread syncs with through this entry. */
  private async planCopies(
    entry: Held,
    uow: UnitOfWork,
    starting: Map<string, SyncedThread[]>,
    message: Message,
    place: number,
    now: number,
  ): Promise<void> {
    const { source, vibe, service, opened } = entry;
    if (message.noSync || message.deletedAt !== null) return;
    const isRoot = message.re === null;
    const threadId = message.re ?? message.id;
    // A thread whose root was posted with noSync is joined with nothing: its
    // root starts no thread here, and joining it later is refused. What is
    // sent is checked against the root once more when it is sent.

    const begun = starting.get(threadId) ?? [];
    const joined = [...(await this.records.threadsOf(source.id, threadId)), ...begun];
    if (isRoot && opened.platform.startsThreads) {
      // A new thread in a mapped channel starts a thread on the platform,
      // unless that is where it came from.
      for (const mapping of startsFrom(source.config, message.channel)) {
        if (joined.some((join) => join.platformChannel === mapping.platform)) continue;
        const start: SyncedThread = {
          id: newId("sth", now),
          sourceId: source.id,
          vibeId: vibe.id,
          threadId,
          platformChannel: mapping.platform,
          platformThread: null,
          url: null,
          sinceSeq: place - 1,
          state: "active",
          createdBy: service.actorId,
          createdAt: now,
        };
        this.records.addThread(uow, start);
        joined.push(start);
        starting.set(threadId, [...(starting.get(threadId) ?? []), start]);
      }
    }

    for (const join of joined) {
      // What was written before the two were joined was sent then, or was
      // never to be.
      if (place <= join.sinceSeq) continue;
      const mapping = mappingFor(source.config, join.platformChannel);
      if (!opened.platform.sends(mapping, { root: isRoot, from: message.from })) continue;
      // A message that came in from this platform thread has its record
      // there already, and so is not sent back to it.
      this.records.planCopy(uow, {
        syncThreadId: join.id,
        messageId: message.id,
        sourceId: source.id,
        direction: "out",
        platformMessage: null,
        url: null,
        state: "pending",
        seq: place,
        attempts: 0,
        retryAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** Sends an edit, a delete or a reaction after the copies it concerns. Once, and whatever comes of it. */
  private async follow(entry: Held, event: VibeEvent, message: Message): Promise<void> {
    const { source, opened } = entry;
    const { platform, context } = opened;
    try {
      for (const copy of await this.records.copiesOf(source.id, message.id)) {
        const { platformThread } = copy.thread;
        if (copy.platformMessage === null || platformThread === null || copy.state !== "done") {
          // Not there yet. When it goes out, it goes out as the message is then.
          continue;
        }
        const thread = { channel: copy.thread.platformChannel, thread: platformThread };
        if (event.type === "reaction.added" || event.type === "reaction.removed") {
          const emoji = String(event.payload["emoji"] ?? "");
          // A reaction a platform user made here came from the platform.
          if (platformUserOf(source.principal, source.key, event.actor.actor) !== null) continue;
          const remove = event.type === "reaction.removed";
          // The entry reacts once for everyone: its reaction stays while anyone's does.
          if (remove && this.stillReacted(entry, message, emoji)) continue;
          await platform.react?.(context, thread, copy.platformMessage, emoji, remove);
          continue;
        }
        // The platform's own messages are the platform's to change.
        if (copy.direction !== "out") continue;
        if (event.type === "message.edited") {
          await platform.edit?.(
            context,
            thread,
            copy.platformMessage,
            this.outgoing(entry, message),
          );
        } else if (event.type === "message.deleted") {
          await platform.remove?.(context, thread, copy.platformMessage);
        }
      }
    } catch (error) {
      console.error(`${source.key} could not follow ${event.type} on ${message.id}.`, error);
    }
  }

  /**
   * Puts on a copy that has just gone out the reactions its message carries.
   * A reaction made while the copy was still on its way had nothing to be
   * put on, and the event that told of it has been passed. Best effort, as
   * every reaction is: what fails here fails nothing else.
   */
  private async reactAsItStands(
    entry: Held,
    message: Message,
    thread: { channel: string; thread: string },
    platformMessage: string,
  ): Promise<void> {
    const { platform, context } = entry.opened;
    if (!platform.react) return;
    // As it is now, not as it was when this pass read it to send.
    const current = (await this.messages.getMessage(entry.vibe.id, message.id)) ?? message;
    for (const reaction of current.reactions) {
      if (!this.stillReacted(entry, current, reaction.emoji)) continue;
      try {
        await platform.react(context, thread, platformMessage, reaction.emoji, false);
      } catch (error) {
        console.error(`A reaction on ${message.id} did not reach ${entry.source.key}.`, error);
      }
    }
  }

  /** Whether someone who isn't one of this entry's platform users still has the reaction on. */
  private stillReacted(entry: Held, message: Message, emoji: string): boolean {
    const { source } = entry;
    const reaction = message.reactions.find((each) => each.emoji === emoji);
    return (reaction?.by ?? []).some(
      (by) => platformUserOf(source.principal, source.key, by.actor) === null,
    );
  }

  /**
   * Sends the copies that are due, in the order their messages were posted.
   *
   * @param keep Renews the pass's hold on the entry. `false` means another pass has it, and this one stops.
   * @returns How many copies it settled one way or another. One that goes on
   *   waiting for its thread doesn't count: a pass that only met those has
   *   nothing more to do until something else moves.
   */
  private async send(
    entry: Held,
    report: SyncReport,
    keep: () => Promise<boolean>,
  ): Promise<number> {
    const { source, vibe } = entry;
    const due = await this.records.due(source.id, this.clock.now(), SEND_BATCH);
    let settled = 0;
    for (const listed of due) {
      if (!(await keep())) return 0;
      // Read again when its turn comes: the copy before it may have started
      // the thread this one waits for.
      const copy = await this.records.current(listed);
      if (copy?.state !== "pending") continue;
      const message = await this.messages.getMessage(vibe.id, copy.messageId);
      const root = message?.re ? await this.messages.getMessage(vibe.id, message.re) : message;
      const sendable =
        message &&
        root &&
        message.deletedAt === null &&
        !message.noSync &&
        !root.noSync &&
        copy.thread.state === "active" &&
        // As when the copy was planned: a copy that waited for a retry goes
        // out only where the service may still read and sync.
        entry.syncs.allows(message.channel) &&
        entry.reads.allows(message.channel);
      if (!message || !sendable) {
        // Deleted before it went out, kept off every platform since, in a
        // thread that never started, or where the service no longer reads or syncs.
        await this.records.skip(copy, this.clock.now());
        settled += 1;
        continue;
      }
      if (await this.deliver(entry, copy, message, report)) settled += 1;
    }
    return settled;
  }

  private async deliver(
    entry: Held,
    copy: PlacedCopy,
    message: Message,
    report: SyncReport,
  ): Promise<boolean> {
    const { source, vibe, service, opened } = entry;
    const { platform, context } = opened;
    const { thread } = copy;
    const isRoot = message.re === null;
    // The root's copy starts the thread on the platform, unless the thread
    // was joined with one that existed. Where the platform took its ID from
    // us, the thread has that ID on record before it is there.
    const starts =
      isRoot && (thread.platformThread === null || thread.platformThread === copy.platformMessage);
    if (!isRoot) {
      // A reply waits for its thread to be on the platform, and goes nowhere
      // if nothing is going to put it there.
      if (await this.records.starting(thread.id, message.re ?? message.id)) return false;
      if (thread.platformThread === null) {
        await this.records.skip(copy, this.clock.now());
        return true;
      }
    }

    const target = formatTarget(
      source.key,
      labelOf(source.config, thread.platformChannel),
      thread.platformThread,
    );
    try {
      // Where the platform takes an ID from us, it is on record before the
      // call: the platform's own news of the message is then known for ours.
      const mint = copy.platformMessage ?? platform.mint?.() ?? null;
      if (mint !== null && copy.platformMessage === null) {
        await this.records.intend(copy, mint, thread.platformThread === null);
      }
      const outgoing = { ...this.outgoing(entry, message), mint };

      if (starts) {
        const said = await platform.start(context, thread.platformChannel, outgoing);
        const sent = { ...said, url: webLink(said.url) };
        await this.records.started(copy, sent, this.clock.now());
        const started = formatTarget(
          source.key,
          labelOf(source.config, thread.platformChannel),
          sent.thread,
        );
        const receipt = { source: source.key, target: started, url: sent.url };
        await this.receipts.note(vibe.id, message.id, "thread.synced", service.actorId, receipt);
        await this.receipts.note(vibe.id, message.id, "message.synced", service.actorId, receipt);
        await this.reactAsItStands(
          entry,
          message,
          { channel: thread.platformChannel, thread: sent.thread },
          sent.message,
        );
      } else {
        const at = { channel: thread.platformChannel, thread: thread.platformThread ?? "" };
        const said = await platform.reply(context, at, outgoing);
        const sent = { ...said, url: webLink(said.url) };
        await this.records.delivered(copy, sent, this.clock.now());
        await this.receipts.note(vibe.id, message.id, "message.synced", service.actorId, {
          source: source.key,
          target,
          url: sent.url,
        });
        await this.reactAsItStands(entry, message, at, sent.message);
      }
      report.delivered += 1;
    } catch (error) {
      const now = this.clock.now();
      const attempts = copy.attempts + 1;
      const said = describeFailure(error);
      const asked = error instanceof PlatformError ? error.retryAfterMs : null;
      const final = error instanceof PlatformError && error.permanent;
      const wait = final ? null : retryWait(attempts, asked);
      if (wait !== null) {
        await this.records.retry(copy, attempts, now + wait, said, now);
        this.trigger?.request(vibe.id, wait);
        report.retried += 1;
        return true;
      }
      // Given up on. The copies after it were never held up, and go on.
      await this.records.failed(copy, attempts, said, now, starts);
      await this.receipts.note(vibe.id, message.id, "message.sync_failed", service.actorId, {
        source: source.key,
        target,
        error: said,
        attempts,
      });
      report.failed += 1;
    }
    return true;
  }

  /** A vibe message as a platform is given it. */
  private outgoing(entry: Held, message: Message): Outgoing {
    const { source } = entry;
    const { by } = message;
    const via = by.handle.split("/")[0] ?? by.handle;
    return {
      id: message.id,
      text: message.text,
      mentions: message.mentions.map((mention) => ({
        actor: mention.actor,
        name: mention.name,
        platformUser: platformUserOf(source.principal, source.key, mention.actor),
      })),
      // As the vibe shows them: a person by name, a profile with who is behind it.
      author: by.profile === null ? by.name : `${by.name} via ${via}`,
      files: message.attachments.map((file) => file.name),
      mint: null,
    };
  }
}
