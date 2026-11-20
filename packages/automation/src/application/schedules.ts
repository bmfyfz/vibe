import { type ActorDirectory, type Authorizer, type Caller, refuseNarrowed } from "@vibe/identity";
import { type BeginUnitOfWork, type Clock, DomainError, newId, notFound } from "@vibe/kernel";
import type { BlockInput, Labels, PostMessage, VibeRecord } from "@vibe/messaging";

import { scheduleNotFound, scheduleNotOwned } from "../domain/errors.ts";
import { Schedule, type ScheduleSnapshot, type Timing } from "../domain/schedule.ts";
import type { CallerDirectory, ScheduleRepository, VibeDirectory } from "./ports.ts";

export interface CreateScheduleCommand {
  caller: Caller;
  vibe: VibeRecord;
  /** Start a thread in this channel at each firing. */
  channel?: string | undefined;
  /** Or reply in the thread that holds this message. */
  re?: string | undefined;
  text: string;
  labels?: Labels | undefined;
  blocks?: readonly BlockInput[] | undefined;
  /** Keep each post off every synced platform. */
  noSync?: boolean | undefined;
  timing: Timing;
}

export interface CancelScheduleCommand {
  caller: Caller;
  vibe: VibeRecord;
  id: string;
}

/** What one pass of the scheduler did. */
export interface FiringReport {
  /** Schedules that posted. */
  fired: number;
  /** Schedules ended because their post was refused. */
  stopped: number;
  /** Schedules whose firing failed for a reason that may pass. They stay due. */
  failed: number;
}

// A cancel that loses a race to a firing reads again and decides again.
const MAX_ATTEMPTS = 4;

/** Posts made later: scheduling them, calling them off, and making them when they are due. */
export class Schedules {
  constructor(
    private readonly repository: ScheduleRepository,
    private readonly poster: PostMessage,
    private readonly vibes: VibeDirectory,
    private readonly callers: CallerDirectory,
    private readonly authorizer: Authorizer,
    private readonly actors: ActorDirectory,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Schedules a post or a reply. It is decided now as the post itself would
   * be, so what would be refused when it fires is refused here: a channel the
   * caller can't post in, a thread they can't read, data that doesn't match.
   *
   * @returns The new schedule's ID.
   */
  async create(command: CreateScheduleCommand): Promise<string> {
    const { repository, poster, actors, begin, clock } = this;
    const { caller, vibe } = command;
    // A schedule fires as its author for as long as they may post there. A
    // limit that ends, as a delegated token's does, would not end with it.
    refuseNarrowed(caller, "schedule posts");
    const content = {
      text: command.text,
      labels: command.labels ?? {},
      blocks: command.blocks ?? [],
      noSync: command.noSync === true,
    };
    const target = await poster.rehearse({
      caller,
      vibe,
      channel: command.channel,
      re: command.re,
      ...content,
    });

    const now = clock.now();
    const schedule = Schedule.create({
      id: newId("sch", now),
      vibeId: vibe.id,
      target,
      content,
      author: caller,
      timing: command.timing,
      now,
    });
    const uow = begin();
    repository.add(uow, schedule);
    actors.introduce(uow, caller, now);
    await uow.commit();
    return schedule.id;
  }

  /**
   * Calls a schedule off. Its author can, and so can anyone with `manage` in
   * its channel.
   *
   * @returns `canceled: false` when the schedule had already ended.
   * @throws `schedule_not_found` for a schedule the caller couldn't see, and
   *   `forbidden` for one that is someone else's to cancel.
   */
  async cancel(command: CancelScheduleCommand): Promise<{ canceled: boolean }> {
    const { repository, authorizer, begin, clock } = this;
    const { caller, vibe, id } = command;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const schedule = await repository.find(vibe.id, id);
      if (!schedule) throw scheduleNotFound(id);
      const was = schedule.snapshot;
      const can = await authorizer.permissions(caller, { vibeId: vibe.id, channel: was.channel });
      // A caller under a limit is its author only where the limit lets it
      // post: elsewhere, what its principal scheduled is not its to call off.
      const author = schedule.scheduledBy(caller) && (caller.narrowed === null || can.has("post"));
      if (!author && !can.has("manage")) {
        throw can.has("read") ? scheduleNotOwned() : scheduleNotFound(id);
      }
      if (!schedule.cancel({ now: clock.now() })) return { canceled: false };

      const uow = begin();
      repository.save(uow, schedule, was);
      await uow.commit();
      // A firing may have got in first, and the save then wrote nothing.
      const now = await repository.find(vibe.id, id);
      if (now?.snapshot.state === "canceled") return { canceled: true };
    }
    return { canceled: false };
  }

  /**
   * Posts what is due, as the scheduler runs it each minute. Each post is made
   * as the schedule's author as they are now, so it takes the grants they hold
   * now: a schedule whose author lost the access its post takes is stopped.
   */
  async fireDue(limit = 50): Promise<FiringReport> {
    const { repository, clock } = this;
    const report: FiringReport = { fired: 0, stopped: 0, failed: 0 };
    for (const listed of await repository.due(clock.now(), limit)) {
      try {
        // Read again when its turn comes. The list is as old as the pass, and
        // a schedule canceled or fired since must not post on the strength of it.
        const schedule = await repository.find(listed.snapshot.vibeId, listed.id);
        if (!schedule?.isDue(clock.now())) continue;
        report[await this.fire(schedule)] += 1;
      } catch (error) {
        // It stays due, and the next pass tries again under the same key.
        report.failed += 1;
        console.error(`Schedule ${listed.id} could not fire; the next pass will retry.`, error);
      }
    }
    return report;
  }

  private async fire(schedule: Schedule): Promise<"fired" | "stopped"> {
    const { repository, poster, begin, clock } = this;
    const was = schedule.snapshot;
    try {
      const { vibe, caller } = await this.author(was);
      const posted = await poster.execute({
        caller,
        vibe,
        ...(was.threadId === null ? { channel: was.channel } : { re: was.replyTo ?? was.threadId }),
        text: was.text,
        labels: was.labels,
        blocks: was.blocks,
        noSync: was.noSync,
        // A firing that posted and then failed to record it posts under the
        // same key the next time, and gets the same message back.
        idempotencyKey: schedule.firingKey,
      });
      schedule.fired({ messageId: posted.messageId, now: clock.now() });
    } catch (error) {
      // A busy thread is worth another try. Any other refusal is final: the
      // same post would be refused the same way a minute from now.
      if (!(error instanceof DomainError) || error.code === "write_conflict") throw error;
      schedule.stop({ reason: error.code, now: clock.now() });
    }

    const uow = begin();
    repository.save(uow, schedule, was);
    await uow.commit();
    return schedule.snapshot.state === "stopped" ? "stopped" : "fired";
  }

  /** Whoever scheduled it, as they are now, and the vibe it posts in. */
  private async author(schedule: ScheduleSnapshot): Promise<{ vibe: VibeRecord; caller: Caller }> {
    const vibe = await this.vibes.find(schedule.vibeId);
    const caller = await this.callers.callerOf(schedule.principal, schedule.profile);
    if (!vibe || !caller || caller.teamId !== vibe.teamId) {
      throw notFound("author_not_found", "Whoever scheduled this is no longer on the team.");
    }
    return { vibe, caller };
  }
}
