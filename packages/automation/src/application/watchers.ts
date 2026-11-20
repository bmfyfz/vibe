import type { VibeEvent, WatcherDelivery } from "@vibe/contracts";
import { type ActorDirectory, type Authorizer, type Caller, refuseNarrowed } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type ChannelScope,
  type Clock,
  ConstraintViolation,
  newId,
} from "@vibe/kernel";
import type { VibeRecord } from "@vibe/messaging";

import { tooManyWatchers, watcherExists, watcherNotFound } from "../domain/errors.ts";
import {
  backoffMs,
  filterOf,
  MAX_WATCHERS_PER_VIBE,
  newWatcherSecret,
  parseWatcherName,
  parseWatcherUrl,
  settleTail,
  signDelivery,
  type StoredTail,
  type Watcher,
  watcherActor,
} from "../domain/watcher.ts";
import type {
  CallerDirectory,
  DeliveryTrigger,
  EventSource,
  Send,
  VibeDirectory,
  WatcherRepository,
} from "./ports.ts";

export interface RegisterWatcherCommand {
  caller: Caller;
  vibe: VibeRecord;
  name: string;
  url: string;
  /** What it follows, already settled: `by` as a handle or an actor ID, `mentions` as an actor ID. */
  tail: {
    channel?: string | undefined;
    re?: string | undefined;
    by?: string | undefined;
    labels?: readonly string[] | undefined;
    mentions?: string | undefined;
    source?: string | undefined;
    all?: boolean | undefined;
  };
}

export interface RemoveWatcherCommand {
  caller: Caller;
  vibe: VibeRecord;
  /** Its ID or its name. */
  id: string;
}

/** What one delivery pass did. */
export interface DeliveryReport {
  /** Events that an endpoint accepted. */
  delivered: number;
  /** Watchers whose endpoint didn't accept a delivery. Each waits, and is tried again. */
  failed: number;
  /** Watchers ended because whoever registered them is gone. */
  stopped: number;
}

// One pass posts this many events to a watcher, then asks for another pass:
// a Worker's invocation has only so many requests to make.
const BATCH = 20;
// How long an endpoint has to answer.
const TIMEOUT_MS = 10_000;
// How long a pass holds a watcher. Renewed at each delivery, so it only has
// to outlast one request to the endpoint and the writes around it.
const HOLD_MS = 60_000;
const MAX_ERROR_LENGTH = 300;
// How long a pass trusts what it read of its registrant's access. A slow
// endpoint can stretch a pass to minutes, and a channel closed meanwhile must
// not go on being delivered from.
const ACCESS_FRESH_MS = 5_000;

/**
 * Webhook watchers: URLs that a vibe's matching events are posted to.
 *
 * Each watcher keeps a cursor into the event log, and the cursor is the only
 * record of what it has been delivered. A delivery is posted, and then the
 * cursor moves. So an event is delivered at least once, and since one pass at
 * a time holds a watcher and stops at the first failure, in the log's order.
 */
export class Watchers {
  constructor(
    private readonly repository: WatcherRepository,
    private readonly events: EventSource,
    private readonly vibes: VibeDirectory,
    private readonly callers: CallerDirectory,
    private readonly authorizer: Authorizer,
    private readonly actors: ActorDirectory,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
    private readonly send: Send,
    private readonly trigger: DeliveryTrigger | undefined,
  ) {}

  /**
   * Registers a watcher. It takes `manage` at `*`: a watcher sends what its
   * registrant can read to a server outside the vibe. It gets the events
   * written from now on.
   *
   * @returns The watcher's ID, and the secret its deliveries are signed with,
   *   which is given this once.
   */
  async register(command: RegisterWatcherCommand): Promise<{ id: string; secret: string }> {
    const { repository, authorizer, actors, begin, clock } = this;
    const { caller, vibe } = command;
    refuseNarrowed(caller, "register watchers");
    await authorizer.requireAtAll(caller, "manage", vibe.id, "register a watcher");

    const name = parseWatcherName(command.name);
    const url = parseWatcherUrl(command.url);
    const tail: StoredTail = settleTail(command.tail);
    if (await repository.find(vibe.id, name)) throw watcherExists(name);
    if ((await repository.count(vibe.id)) >= MAX_WATCHERS_PER_VIBE) {
      throw tooManyWatchers(MAX_WATCHERS_PER_VIBE);
    }

    const now = clock.now();
    const watcher: Watcher = {
      id: newId("w", now),
      vibeId: vibe.id,
      name,
      url,
      tail,
      secret: newWatcherSecret(),
      actorId: caller.actorId,
      principal: caller.principal,
      state: "active",
      reason: null,
      createdAt: now,
    };
    const uow = begin();
    repository.add(uow, watcher, await this.events.place(vibe.id), now);
    actors.introduce(uow, caller, now);
    try {
      await uow.commit();
    } catch (error) {
      // Someone registered the same name between our read and our write.
      if (error instanceof ConstraintViolation) throw watcherExists(name);
      throw error;
    }
    return { id: watcher.id, secret: watcher.secret };
  }

  /** Lists nothing itself: says whether the caller may see the vibe's watchers. Takes `manage` at `*`. */
  async requireList(caller: Caller, vibe: VibeRecord): Promise<void> {
    await this.authorizer.requireAtAll(caller, "manage", vibe.id, "list this vibe's watchers");
  }

  /**
   * Deletes a watcher: whoever registered it can, and so can anyone with
   * `manage` at `*`. What it had not been delivered yet, it never is.
   *
   * @throws `watcher_not_found` for a caller who may not see the vibe's watchers.
   */
  async remove(command: RemoveWatcherCommand): Promise<Watcher> {
    const { repository, authorizer, begin } = this;
    const { caller, vibe } = command;
    refuseNarrowed(caller, "delete watchers");
    const watcher = await repository.find(vibe.id, command.id);
    const mine = watcher?.principal === caller.principal;
    if (!mine) {
      try {
        await authorizer.requireAtAll(caller, "manage", vibe.id, "delete a watcher");
      } catch (error) {
        // To a caller who may not list them, a watcher isn't there to be refused.
        if (!watcher) throw watcherNotFound(command.id);
        throw error;
      }
    }
    if (!watcher) throw watcherNotFound(command.id);
    const uow = begin();
    repository.remove(uow, watcher);
    await uow.commit();
    return watcher;
  }

  /**
   * Asks for a delivery pass when a vibe that has watchers has just been
   * written to. The cost to a vibe without any is one small read.
   */
  async noticed(vibeId: string): Promise<void> {
    if (!this.trigger) return;
    if ((await this.repository.count(vibeId)) > 0) this.trigger.request(vibeId, 0);
  }

  /** Delivers what a vibe's watchers are behind on. What a queue or a timer runs after a write. */
  async deliverVibe(vibeId: string): Promise<DeliveryReport> {
    return this.pass(await this.repository.active(vibeId));
  }

  /**
   * Delivers to every watcher that is behind and not waiting, in any vibe.
   * The scheduler runs it each minute, so a prompt that went missing costs a
   * minute at most.
   */
  async deliverDue(limit = 50): Promise<DeliveryReport> {
    return this.pass(await this.repository.due(this.clock.now(), limit));
  }

  private async pass(watchers: readonly Watcher[]): Promise<DeliveryReport> {
    const report: DeliveryReport = { delivered: 0, failed: 0, stopped: 0 };
    for (const watcher of watchers) {
      try {
        await this.deliver(watcher, report);
      } catch (error) {
        // Its cursor is where the last delivery left it, and its hold runs out
        // by itself: the next pass carries on from there.
        console.error(`Delivering to watcher ${watcher.id} failed; a later pass retries.`, error);
      }
    }
    return report;
  }

  /** Posts a watcher the events it is behind on, in order, until one isn't accepted. */
  private async deliver(watcher: Watcher, report: DeliveryReport): Promise<void> {
    const { repository, clock } = this;
    const held = await repository.lease(watcher.id, clock.now(), clock.now() + HOLD_MS);
    if (!held) return;

    // The watcher reads as whoever registered it, with the access they have now.
    const vibe = await this.vibes.find(watcher.vibeId);
    const caller = await this.callers.callerOf(watcher.principal, null);
    if (!vibe || !caller || caller.teamId !== vibe.teamId) {
      await repository.stop(watcher.id, "author_not_found");
      report.stopped += 1;
      return;
    }

    const scope = () => this.authorizer.scope(caller, vibe.id);
    const filter = filterOf(watcher.tail);
    const page = await this.events.since(vibe.id, held.seq, filter, BATCH, scope);
    const self = watcherActor(watcher);
    let seq = held.seq;
    let checkedAt = clock.now();
    let current: ChannelScope | null = null;
    for (const { place, channel, event } of page.events) {
      // What the watcher wrote itself is not news to it.
      if (event.actor.actor === self) continue;
      // The page was read with the access the registrant had then. Once that
      // is a while ago, it is looked at again before anything more goes out.
      if (clock.now() - checkedAt > ACCESS_FRESH_MS) {
        current = await scope();
        checkedAt = clock.now();
      }
      if (current && !(channel === null ? current.all : current.allows(channel))) continue;

      const failure = await this.post(watcher, vibe, event);
      const now = clock.now();
      if (failure) {
        const attempts = held.attempts + 1;
        const wait = backoffMs(attempts);
        await repository.failed(
          watcher.id,
          seq,
          { attempts, retryAt: now + wait, ...failure },
          now,
        );
        this.trigger?.request(vibe.id, wait);
        report.failed += 1;
        return;
      }
      if (!(await repository.advance(watcher.id, seq, place, now, now + HOLD_MS))) return;
      held.attempts = 0;
      seq = place;
      report.delivered += 1;
    }
    await repository.settle(watcher.id, seq, page.upto, clock.now());
    // A full page may have left more behind it. And whatever was written
    // while this pass held the watcher asked for a pass that found it held:
    // if the log has moved on, this pass asks again on its behalf.
    if (!this.trigger) return;
    const more = page.events.length === BATCH || (await this.events.place(vibe.id)) > page.upto;
    if (more) this.trigger.request(vibe.id, 0);
  }

  /**
   * Posts one event to a watcher's endpoint.
   *
   * @returns `null` when the endpoint accepted it, with any 2xx. Otherwise
   *   what went wrong, to record and to show.
   */
  private async post(
    watcher: Watcher,
    vibe: VibeRecord,
    event: VibeEvent,
  ): Promise<{ status: number | null; error: string } | null> {
    const delivery: WatcherDelivery = {
      id: `${watcher.id}:${event.cursor}`,
      watcher: { id: watcher.id, name: watcher.name },
      vibe: { id: vibe.id, name: vibe.name },
      event,
    };
    const body = JSON.stringify(delivery);
    const timestamp = Math.floor(this.clock.now() / 1000);
    try {
      const response = await this.send(watcher.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "vibe-watcher/1",
          "vibe-watcher": watcher.name,
          "vibe-delivery": delivery.id,
          "vibe-timestamp": String(timestamp),
          "vibe-signature": await signDelivery(watcher.secret, timestamp, body),
        },
        body,
        // A redirect is not followed: the endpoint that was registered is the
        // one that gets the vibe's events, and no other.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) return null;
      return { status: response.status, error: `The endpoint answered ${response.status}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: null, error: message.slice(0, MAX_ERROR_LENGTH) };
    }
  }
}
