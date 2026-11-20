import type { Channel } from "@vibe/contracts";
import type { ActorDirectory, Authorizer, Caller, Grants, GrantView } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type Clock,
  conflict,
  type EventLog,
  parseChannelPath,
} from "@vibe/kernel";

import { writeConflict } from "../domain/errors.ts";
import type { ChannelRepository, VibeRecord } from "./ports.ts";

export interface CreateChannelCommand {
  caller: Caller;
  vibe: VibeRecord;
  path: string;
  /** Close the new channel to everyone but its creator. */
  private?: boolean | undefined;
}

export interface CreatedChannel {
  channel: Channel;
  /** `false` when the channel already existed, and was left as it is. */
  created: boolean;
  /** The grants that make a private channel private: one lets its creator in, one closes it to everyone else. */
  grants?: GrantView[];
}

const MAX_ATTEMPTS = 5;

/** Creates channels before anything posts to them. A first post needs none of this. */
export class Channels {
  constructor(
    private readonly channels: ChannelRepository,
    private readonly grants: Pick<Grants, "closeToAllBut" | "lostRace" | "requirePrivate">,
    private readonly eventLog: EventLog,
    private readonly authorizer: Authorizer,
    private readonly actors: ActorDirectory,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  async create(command: CreateChannelCommand): Promise<CreatedChannel> {
    const path = parseChannelPath(command.path);
    return command.private === true ? this.createPrivate(command, path) : this.open(command, path);
  }

  /** Creates an empty channel, so people can find it and followers can tail it. */
  private async open(command: CreateChannelCommand, path: string): Promise<CreatedChannel> {
    const { channels, authorizer } = this;
    const { caller, vibe } = command;
    const resource = { vibeId: vibe.id, channel: path };
    await authorizer.require(caller, "read", resource);
    await authorizer.require(caller, "post", resource);

    const existing = await channels.find(vibe.id, path);
    if (existing) return { channel: existing, created: false };

    const now = this.clock.now();
    const uow = this.begin();
    this.add(uow, command, path, now);
    try {
      await uow.commit();
    } catch (error) {
      // Someone created it between the look and the write. It exists, which is what was asked.
      const raced = channels.isTaken(error) ? await channels.find(vibe.id, path) : null;
      if (!raced) throw error;
      return { channel: raced, created: false };
    }
    return { channel: view(path, now), created: true };
  }

  /**
   * Creates a channel that only its creator can use, with the two grants that
   * make it so, in one commit: the channel never exists without them.
   */
  private async createPrivate(
    command: CreateChannelCommand,
    path: string,
  ): Promise<CreatedChannel> {
    const { channels, grants } = this;
    const { caller, vibe } = command;

    await grants.requirePrivate(caller, vibe.id, path);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (await channels.existsAtOrUnder(vibe.id, path)) throw channelExists(path);

      const now = this.clock.now();
      const uow = this.begin();
      const made = await grants.closeToAllBut(uow, caller, vibe.id, path, now);
      this.add(uow, command, path, now);
      try {
        await uow.commit();
        return { channel: view(path, now), created: true, grants: made };
      } catch (error) {
        if (channels.isTaken(error)) throw channelExists(path);
        if (!grants.lostRace(error)) throw error;
      }
    }
    throw writeConflict();
  }

  private add(
    uow: ReturnType<BeginUnitOfWork>,
    command: CreateChannelCommand,
    path: string,
    now: number,
  ): void {
    const { caller, vibe } = command;
    this.channels.add(uow, { vibeId: vibe.id, path, createdBy: caller.actorId, createdAt: now });
    this.eventLog.append(uow, [
      {
        vibeId: vibe.id,
        type: "channel.created",
        channel: path,
        threadId: null,
        threadVersion: null,
        messageId: null,
        actorId: caller.actorId,
        payload: { private: command.private === true },
        facets: null,
        createdAt: now,
      },
    ]);
    this.actors.introduce(uow, caller, now);
  }
}

function view(path: string, createdAt: number): Channel {
  return { path, createdAt: new Date(createdAt).toISOString() };
}

const channelExists = (path: string) =>
  conflict(
    "channel_exists",
    `The channel ${path}, or a channel under it, already exists, so nothing was created.`,
    "A private channel starts empty. Pick a path nobody has posted to.",
  );
