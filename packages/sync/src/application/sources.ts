import type { SyncInboxEntry } from "@vibe/contracts";
import { type Authorizer, type Caller, refuseNarrowed } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type Clock,
  ConstraintViolation,
  forbidden,
  newId,
} from "@vibe/kernel";
import type { VibeRecord } from "@vibe/messaging";

import { PlatformError } from "../domain/delivery.ts";
import {
  invalidSource,
  ownersOnly,
  sourceExists,
  sourceNotFound,
  syncUnavailable,
  tooManySources,
} from "../domain/errors.ts";
import {
  assertMappings,
  type Credentials,
  isPlatform,
  MAX_SOURCES_PER_VIBE,
  parseSourceKey,
  type Source,
} from "../domain/source.ts";
import type { Contexts } from "./contexts.ts";
import type { MapInput } from "./platform.ts";
import type {
  EventSource,
  Inbox,
  ServiceDirectory,
  SourceRepository,
  StoredSource,
} from "./ports.ts";

export interface CreateSourceCommand {
  caller: Caller;
  vibe: VibeRecord;
  key: string;
  platform: string;
  /** The name of the service the entry acts as. */
  service: string;
  map: Readonly<Record<string, MapInput>>;
  credentials: { token?: string | undefined; secret: string };
  api?: string | undefined;
}

/**
 * A vibe's sync entries. Vibe has no deployment of yours to configure in
 * code, so an entry is data: a platform account, its
 * credentials, the channels it maps, and the service it acts as.
 */
export class Sources {
  constructor(
    private readonly repository: SourceRepository,
    private readonly inbox: Inbox,
    private readonly contexts: Contexts,
    private readonly services: ServiceDirectory,
    private readonly events: EventSource,
    private readonly authorizer: Authorizer,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Adds a sync entry. Only a team owner can: an entry holds a platform's
   * credentials, and decides what leaves the vibe and what comes into it. The
   * platform is asked who the credentials are, so one that doesn't work is
   * refused here.
   */
  async create(command: CreateSourceCommand): Promise<Source> {
    const { repository, contexts, begin, clock } = this;
    const { caller, vibe } = command;
    refuseNarrowed(caller, "set up sync");
    if (caller.role !== "owner") throw ownersOnly("set up sync");
    if (!contexts.available) throw syncUnavailable();

    const key = parseSourceKey(command.key);
    if (!isPlatform(command.platform)) {
      throw invalidSource(`"${command.platform}" is not a platform Vibe syncs with.`);
    }
    const principal = await this.services.principalOf(caller, command.service);
    if (principal === null) {
      throw invalidSource(
        `This team has no service named ${command.service}.`,
        `A sync entry acts as a service. Add one first: vibe services create ${command.service}`,
      );
    }
    if (await repository.find(vibe.id, key)) throw sourceExists(key);
    if ((await repository.count(vibe.id)) >= MAX_SOURCES_PER_VIBE) {
      throw tooManySources(MAX_SOURCES_PER_VIBE);
    }

    const credentials: Credentials = {
      token: command.credentials.token?.trim() || null,
      secret: command.credentials.secret.trim(),
    };
    const platform = contexts.platformOf({ platform: command.platform });
    const config = await platform
      .connect({ credentials, map: command.map, api: command.api, send: contexts.sender })
      .catch((error: unknown) => {
        // The platform refused the credentials, or could not be asked.
        if (!(error instanceof PlatformError)) throw error;
        throw invalidSource(
          error.message,
          "Check the credentials, and that the platform's API can be reached from here.",
        );
      });
    assertMappings(config.mappings);

    const now = clock.now();
    const id = newId("src", now);
    const sealed = await contexts.seal(id, credentials);
    if (sealed === null) throw syncUnavailable();
    const source: StoredSource = {
      id,
      vibeId: vibe.id,
      key,
      platform: command.platform,
      principal,
      config,
      state: "active",
      reason: null,
      createdBy: caller.actorId,
      createdAt: now,
      sealed,
    };
    const uow = begin();
    // It reads the log from here: what was written before it existed stays where it is.
    repository.add(uow, source, await this.events.place(vibe.id), now);
    try {
      await uow.commit();
    } catch (error) {
      // Someone took the key between our read and our write.
      if (error instanceof ConstraintViolation) throw sourceExists(key);
      throw error;
    }
    return source;
  }

  /**
   * Replaces an entry's token, the secret its webhooks are signed with, or
   * both. What isn't given stays. For a token that was rotated, and for a
   * platform that only says what it signs with once the webhook exists.
   *
   * The platform is asked who the credentials are again, so a token that
   * doesn't work changes nothing.
   *
   * When the operator's secret has changed, what was kept can't be read any
   * more. The entry is then given its credentials whole, and keeps the
   * threads it syncs: removing it to add it again would lose them.
   */
  async recredential(
    caller: Caller,
    vibe: VibeRecord,
    key: string,
    given: { token?: string | undefined; secret?: string | undefined },
  ): Promise<Source> {
    const { contexts } = this;
    refuseNarrowed(caller, "set up sync");
    if (caller.role !== "owner") throw ownersOnly("change a sync entry's credentials");
    const source = await this.find(vibe, key);
    if (!contexts.available) throw syncUnavailable();
    const platform = contexts.platformOf(source);
    // Sealed under a key this Vibe no longer has, they open for no one.
    const kept = await contexts.open(source).then(
      (opened) => opened.context.credentials,
      () => null,
    );
    const secret = given.secret?.trim() || kept?.secret;
    if (secret === undefined) {
      throw invalidSource(
        `What ${source.key} was given can no longer be read: the operator's secret has changed since.`,
        "Give its credentials whole: the webhook secret, and the token if it has one.",
      );
    }
    const credentials: Credentials = { token: given.token?.trim() || kept?.token || null, secret };
    const identity = await platform
      .identify({ credentials, api: source.config.api, send: contexts.sender })
      .catch((error: unknown) => {
        if (!(error instanceof PlatformError)) throw error;
        throw invalidSource(
          error.message,
          "Check the credentials, and that the platform's API can be reached from here.",
        );
      });
    const sealed = await contexts.seal(source.id, credentials);
    if (sealed === null) throw syncUnavailable();
    const changed: StoredSource = { ...source, config: { ...source.config, ...identity }, sealed };
    const uow = this.begin();
    this.repository.recredential(uow, changed);
    await uow.commit();
    return changed;
  }

  /**
   * Removes a sync entry, with its credentials and its records of what is
   * synced where. What came in through it stays on the vibe, and what went
   * out stays on the platform.
   */
  async remove(caller: Caller, vibe: VibeRecord, key: string): Promise<Source> {
    refuseNarrowed(caller, "remove sync entries");
    if (caller.role !== "owner") throw ownersOnly("remove a sync entry");
    const source = await this.find(vibe, key);
    const uow = this.begin();
    this.repository.remove(uow, source);
    await uow.commit();
    return source;
  }

  /**
   * Says whether the caller may see the vibe's sync entries: anyone who can
   * read something here, so that anyone can check where their words may go.
   * Not a caller under a limit, which is shown none of sync's records.
   */
  async requireList(caller: Caller, vibe: VibeRecord): Promise<void> {
    refuseNarrowed(caller, "read sync's records");
    await this.authorizer.require(caller, "read", { vibeId: vibe.id, channel: null });
  }

  /**
   * The raw events an entry received, newest first. It takes `sync` at `*`,
   * and `read` of every channel the entry writes into: the ones it maps, and
   * the channel of every thread that was joined to a platform thread by
   * hand. An event holds what was written in one of them, whichever it was,
   * and a reply in a joined thread lands in that thread's channel, which no
   * mapping names.
   */
  async received(
    caller: Caller,
    vibe: VibeRecord,
    key: string,
    limit: number,
  ): Promise<SyncInboxEntry[]> {
    refuseNarrowed(caller, "read sync's records");
    await this.authorizer.requireAtAll(caller, "sync", vibe.id, "read what a platform sent");
    const source = await this.find(vibe, key);
    const reads = await this.authorizer.scope(caller, vibe.id);
    const channels = [
      ...source.config.mappings.map((mapping) => mapping.channel),
      ...(await this.inbox.writesInto(source.id)),
    ];
    if (channels.some((channel) => !reads.allows(channel))) {
      throw forbidden(
        "forbidden",
        `To read what ${source.key} was sent, you need to read every channel it writes into.`,
      );
    }
    return this.inbox.list(source.id, limit);
  }

  private async find(vibe: VibeRecord, key: string): Promise<StoredSource> {
    const source = await this.repository.find(vibe.id, key.trim().toLowerCase());
    if (!source) throw sourceNotFound(key);
    return source;
  }
}
