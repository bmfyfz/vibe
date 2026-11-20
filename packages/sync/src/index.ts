import type { Authorizer } from "@vibe/identity";
import { type BeginUnitOfWork, type Clock, type EventLog, systemClock } from "@vibe/kernel";
import type { Messaging } from "@vibe/messaging";
import type { Db } from "@vibe/store";

import { Attach } from "./application/attach.ts";
import { Contexts } from "./application/contexts.ts";
import { Receive } from "./application/inbound.ts";
import { Deliveries } from "./application/outbound.ts";
import type { Platforms, Send } from "./application/platform.ts";
import type {
  CallerDirectory,
  DeliveryTrigger,
  EventSource,
  ServiceDirectory,
  SyncQueries,
} from "./application/ports.ts";
import { Receipts } from "./application/receipts.ts";
import { Sources } from "./application/sources.ts";
import { AesVault } from "./infrastructure/aes-vault.ts";
import { DrizzleSyncQueries } from "./infrastructure/drizzle-sync-queries.ts";
import {
  DrizzleCursorRepository,
  DrizzleInbox,
  DrizzlePlatformActors,
  DrizzleSourceRepository,
  DrizzleSyncRecords,
  DrizzleThreadReader,
} from "./infrastructure/drizzle-sync.ts";
import { GitHubPlatform } from "./infrastructure/platforms/github.ts";
import { LinearPlatform } from "./infrastructure/platforms/linear.ts";
import { SlackPlatform } from "./infrastructure/platforms/slack.ts";

export type { Attach, AttachCommand, Joining } from "./application/attach.ts";
export type { Receive, WebhookAnswer } from "./application/inbound.ts";
export type { Deliveries, SyncReport } from "./application/outbound.ts";
export type { MapInput, RawWebhook, Send } from "./application/platform.ts";
export type {
  CallerDirectory,
  DeliveryTrigger,
  EventSource,
  ServiceDirectory,
  SyncQueries,
} from "./application/ports.ts";
export type { CreateSourceCommand, Sources } from "./application/sources.ts";
export { MAX_RETRIES } from "./domain/delivery.ts";
export { alreadySynced, sourceNotFound } from "./domain/errors.ts";
export { MAX_SOURCES_PER_VIBE, PLATFORMS, type PlatformKind } from "./domain/source.ts";

export interface Sync {
  /** The vibe's sync entries. */
  sources: Sources;
  /** Joining threads with platform threads, and saying where a thread is synced. */
  attach: Attach;
  /** What a platform sends: its webhooks. */
  receive: Receive;
  /** What goes out to the platforms, from the event log. */
  deliveries: Deliveries;
  queries: SyncQueries;
}

/**
 * Wires the Sync context: threads connected with Slack threads, GitHub pull
 * requests and issues, and Linear issues. It reads the event log from a
 * cursor of its own per sync entry, and writes through Messaging as the
 * service each entry acts as.
 */
export function createSync(deps: {
  db: Db;
  begin: BeginUnitOfWork;
  eventLog: EventLog;
  authorizer: Authorizer;
  callers: CallerDirectory;
  services: ServiceDirectory;
  messaging: Messaging;
  /** The event log, for each entry to read from its own place in it. */
  events: EventSource;
  /**
   * A secret of the deployment that platform credentials are sealed under.
   * Left out, no entry can be made, and none that exists is run.
   */
  secret?: string | undefined;
  /** How the platforms are reached. `fetch`, when left out. */
  send?: Send | undefined;
  /** What runs a pass later. Left out, deliveries go out only when a pass is called for. */
  deliveries?: DeliveryTrigger | undefined;
  clock?: Clock | undefined;
}): Sync {
  const clock = deps.clock ?? systemClock;
  const { db, begin, authorizer, callers, events, messaging } = deps;
  const platforms: Platforms = {
    slack: new SlackPlatform(),
    github: new GitHubPlatform(),
    linear: new LinearPlatform(),
  };
  const contexts = new Contexts(
    deps.secret ? new AesVault(deps.secret) : null,
    platforms,
    deps.send ?? ((url, init) => fetch(url, init)),
  );
  const sources = new DrizzleSourceRepository(db);
  const records = new DrizzleSyncRecords(db);
  const inbox = new DrizzleInbox(db);
  const queries = new DrizzleSyncQueries(db);
  const receipts = new Receipts(messaging.threads, deps.eventLog, begin, clock);
  const vibes = { find: (id: string) => messaging.vibes.find(id) };

  return {
    sources: new Sources(sources, inbox, contexts, deps.services, events, authorizer, begin, clock),
    attach: new Attach(
      sources,
      records,
      queries,
      new DrizzleThreadReader(db),
      contexts,
      callers,
      authorizer,
      events,
      receipts,
      begin,
      clock,
      deps.deliveries,
    ),
    receive: new Receive(
      sources,
      records,
      inbox,
      contexts,
      new DrizzlePlatformActors(db),
      vibes,
      callers,
      authorizer,
      messaging.postMessage,
      messaging.changeMessage,
      messaging.queries,
      events,
      receipts,
      clock,
    ),
    deliveries: new Deliveries(
      sources,
      new DrizzleCursorRepository(db),
      records,
      events,
      messaging.queries,
      vibes,
      callers,
      authorizer,
      contexts,
      receipts,
      begin,
      clock,
      deps.deliveries,
    ),
    queries,
  };
}
