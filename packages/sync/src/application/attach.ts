import type { SyncedView } from "@vibe/contracts";
import { type Authorizer, type Caller, refuseNarrowed } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type Clock,
  forbidden,
  newId,
  parseChannelPath,
  type UnitOfWork,
} from "@vibe/kernel";
import { messageNotFound, type Posted, type VibeRecord } from "@vibe/messaging";

import { PlatformError } from "../domain/delivery.ts";
import { alreadySynced, invalidTarget, sourceNotFound, threadNotSynced } from "../domain/errors.ts";
import { labelOf } from "../domain/source.ts";
import { formatTarget, parseTarget, type Place, webLink } from "../domain/target.ts";
import type { Contexts } from "./contexts.ts";
import type {
  CallerDirectory,
  DeliveryTrigger,
  EventSource,
  SourceRepository,
  StoredSource,
  SyncedThread,
  SyncQueries,
  SyncRecords,
  ThreadReader,
} from "./ports.ts";
import type { Receipts } from "./receipts.ts";

export interface AttachCommand {
  caller: Caller;
  vibe: VibeRecord;
  /** Any message of the thread. */
  messageId: string;
  /** A sync entry's key and a platform channel or thread, such as `slack:#incidents`. */
  target: string;
}

/** A target that was checked and found on its platform, ready to be joined with a thread. */
interface Settled {
  source: StoredSource;
  /** The service the entry acts as, as it is now. */
  service: Caller;
  place: Place;
  /** The target as it is shown. */
  shown: string;
}

/** What a post that also syncs writes in its own commit, and does once that has landed. */
export interface Joining {
  alongside(uow: UnitOfWork, posted: Posted): void;
  joined(posted: { messageId: string }): Promise<void>;
}

/** Joins vibe threads with platform threads, and says where a thread is synced. */
export class Attach {
  constructor(
    private readonly sources: SourceRepository,
    private readonly records: SyncRecords,
    private readonly queries: SyncQueries,
    private readonly threads: ThreadReader,
    private readonly contexts: Contexts,
    private readonly callers: CallerDirectory,
    private readonly authorizer: Authorizer,
    private readonly events: EventSource,
    private readonly receipts: Receipts,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
    private readonly trigger: DeliveryTrigger | undefined,
  ) {}

  /**
   * Syncs a thread with a platform. A channel target starts a thread there
   * and sends the thread's messages in order. A thread target joins a thread
   * that exists, which receives what is written after.
   *
   * It takes `sync` in the thread's channel, of the caller and of the service
   * the entry acts as.
   *
   * @returns `attached: false` when the thread already synced there.
   * @throws `already_synced` when the platform thread syncs with another
   *   thread, and `no_sync` when the thread's root keeps it off every platform.
   */
  async attach(command: AttachCommand): Promise<{ target: string; attached: boolean }> {
    const { records, begin, clock } = this;
    const { caller, vibe } = command;
    refuseNarrowed(caller, "sync threads");
    const outline = await this.threads.outline(vibe.id, command.messageId);
    if (!outline) throw messageNotFound(command.messageId);
    const can = await this.authorizer.permissions(caller, {
      vibeId: vibe.id,
      channel: outline.channel,
    });
    // A thread the caller can't read is, to them, not there.
    if (!can.has("read")) throw messageNotFound(command.messageId);

    const { source, service, place, shown } = await this.settle(
      caller,
      vibe,
      outline.channel,
      command.target,
    );
    if (outline.noSync) throw threadNotSynced();

    const already = (await records.threadsOf(source.id, outline.id)).some((joined) =>
      place.thread === null
        ? joined.platformChannel === place.channel
        : joined.platformThread === place.thread,
    );
    if (already) return { target: shown, attached: false };

    const now = clock.now();
    const joined = await this.join(source, vibe, outline.id, place, caller, now);
    const uow = begin();
    records.addThread(uow, joined);
    if (place.thread === null) {
      // The thread starts there, and what it holds follows its root, in order.
      for (const message of outline.messages) {
        if (message.deleted || message.noSync) continue;
        records.planCopy(uow, {
          syncThreadId: joined.id,
          messageId: message.id,
          sourceId: source.id,
          direction: "out",
          platformMessage: null,
          url: null,
          state: "pending",
          seq: message.seq,
          attempts: 0,
          retryAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    try {
      await uow.commit();
    } catch (error) {
      if (records.isTaken(error)) throw alreadySynced();
      throw error;
    }
    if (place.thread !== null) await this.connected(source, service, joined, shown);
    this.trigger?.request(vibe.id, 0);
    return { target: shown, attached: true };
  }

  /**
   * Checks the targets of a post that also syncs, before the post is made:
   * what would be refused once it has landed is refused now. The joins are
   * then written in the post's own commit, so a thread is never posted
   * without them.
   */
  async prepare(
    caller: Caller,
    vibe: VibeRecord,
    channel: string,
    targets: readonly string[],
  ): Promise<Joining> {
    refuseNarrowed(caller, "sync threads");
    const path = parseChannelPath(channel);
    const settled: Settled[] = [];
    for (const target of targets) settled.push(await this.settle(caller, vibe, path, target));
    const now = this.clock.now();
    // Read before the post: the post's own event lands after it, and so goes out.
    const since = await this.events.place(vibe.id);
    const joins = settled.map((each) => ({
      ...each,
      id: newId("sth", now),
    }));

    return {
      alongside: (uow, posted) => {
        for (const { id, source, place } of joins) {
          this.records.addThread(uow, {
            id,
            sourceId: source.id,
            vibeId: vibe.id,
            threadId: posted.threadId,
            platformChannel: place.channel,
            platformThread: place.thread,
            url: place.url,
            sinceSeq: since,
            state: "active",
            createdBy: caller.actorId,
            createdAt: now,
          });
        }
      },
      joined: async (posted) => {
        for (const { source, service, place, shown } of joins) {
          if (place.thread === null) continue;
          await this.receipts.note(vibe.id, posted.messageId, "thread.synced", service.actorId, {
            source: source.key,
            target: shown,
            url: place.url,
          });
        }
        this.trigger?.request(vibe.id, 0);
      },
    };
  }

  /** Whether a failed commit of a post that also syncs found a platform thread taken. */
  isTaken(error: unknown): boolean {
    return this.records.isTaken(error);
  }

  /**
   * Where a thread is synced: each platform thread, with the platform's link
   * to the copy of the message asked about, and the deliveries that failed.
   */
  async synced(caller: Caller, vibe: VibeRecord, messageId: string): Promise<SyncedView> {
    const outline = await this.threads.outline(vibe.id, messageId);
    if (!outline) throw messageNotFound(messageId);
    const scope = await this.authorizer.scope(caller, vibe.id);
    if (!scope.allows(outline.channel)) throw messageNotFound(messageId);
    return this.queries.synced(vibe.id, outline.id, messageId);
  }

  /** Reads a target, and checks that the caller and the entry's service may both sync the channel. */
  private async settle(
    caller: Caller,
    vibe: VibeRecord,
    channel: string,
    target: string,
  ): Promise<Settled> {
    const { key, rest } = parseTarget(target);
    const source = await this.sources.find(vibe.id, key);
    if (!source) throw sourceNotFound(key);
    if (source.state !== "active") {
      throw invalidTarget(`The sync entry ${key} has stopped, and syncs nothing.`);
    }
    await this.authorizer.require(caller, "sync", { vibeId: vibe.id, channel });

    const service = await this.callers.callerOf(source.principal, null);
    const granted = service
      ? await this.authorizer.permissions(service, { vibeId: vibe.id, channel })
      : new Set<string>();
    if (!service || !granted.has("read") || !granted.has("sync") || !granted.has("post")) {
      throw forbidden(
        "forbidden",
        `The service behind ${key} can't read, post and sync in the ${channel} channel.`,
        `A sync entry works where its service may. \`vibe grants explain ${channel} --service ${service?.handle ?? "<name>"}\` shows which grant decides.`,
      );
    }

    const { platform, context } = await this.contexts.open(source);
    const placed = await platform.place(context, rest).catch((error: unknown) => {
      if (!(error instanceof PlatformError)) throw error;
      throw invalidTarget(error.message);
    });
    const place = { ...placed, url: webLink(placed.url) };
    const shown = formatTarget(key, labelOf(source.config, place.channel), place.thread);
    await this.requireReach(caller, vibe, source, place, shown);
    return { source, service, place, shown };
  }

  /**
   * A platform thread is reached from a vibe thread by whoever may already
   * read what comes in from its channel. `sync` in the vibe thread's own
   * channel says nothing of the platform's side: without this, it would let a
   * caller bring a pull request's reviews into a thread of their own, out of
   * a channel closed to them, or listen to a thread in a platform channel
   * nobody mapped.
   *
   * So where the entry maps the platform channel, the caller needs `read` and
   * `sync` in every vibe channel it is mapped to. Where it maps it nowhere,
   * `sync` is enough to start a thread there, which brings in only the
   * answers to what the caller sent, and joining a thread that exists is for
   * a team owner. An owner reaches any.
   */
  private async requireReach(
    caller: Caller,
    vibe: VibeRecord,
    source: StoredSource,
    place: Place,
    shown: string,
  ): Promise<void> {
    if (caller.role === "owner") return;
    const mapped = source.config.mappings.filter((mapping) => mapping.platform === place.channel);
    let reached = mapped.length > 0 || place.thread === null;
    for (const { channel } of mapped) {
      const there = await this.authorizer.permissions(caller, { vibeId: vibe.id, channel });
      if (!there.has("read") || !there.has("sync")) reached = false;
    }
    if (reached) return;
    // The same words whether it is mapped or not: which channels an entry maps is not for everyone.
    throw forbidden(
      "forbidden",
      `You can't sync a thread with ${shown}.`,
      "A thread joins a platform thread whose channel the entry maps to a channel you can read and sync. A team owner can join any other.",
    );
  }

  private async join(
    source: StoredSource,
    vibe: VibeRecord,
    threadId: string,
    place: Place,
    caller: Caller,
    now: number,
  ): Promise<SyncedThread> {
    return {
      id: newId("sth", now),
      sourceId: source.id,
      vibeId: vibe.id,
      threadId,
      platformChannel: place.channel,
      platformThread: place.thread,
      url: place.url,
      sinceSeq: await this.events.place(vibe.id),
      state: "active",
      createdBy: caller.actorId,
      createdAt: now,
    };
  }

  private connected(
    source: StoredSource,
    service: Caller,
    joined: SyncedThread,
    shown: string,
  ): Promise<void> {
    return this.receipts.note(joined.vibeId, joined.threadId, "thread.synced", service.actorId, {
      source: source.key,
      target: shown,
      url: joined.url,
    });
  }
}
