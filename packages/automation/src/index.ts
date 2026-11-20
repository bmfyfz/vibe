import type { ActorDirectory, Authorizer } from "@vibe/identity";
import { type BeginUnitOfWork, type Clock, systemClock } from "@vibe/kernel";
import type { Messaging } from "@vibe/messaging";
import type { Db } from "@vibe/store";

import type {
  CallerDirectory,
  DeliveryTrigger,
  EventSource,
  ScheduleQueries,
  Send,
  WatcherQueries,
} from "./application/ports.ts";
import { Schedules } from "./application/schedules.ts";
import { Watchers } from "./application/watchers.ts";
import {
  DrizzleScheduleQueries,
  DrizzleScheduleRepository,
} from "./infrastructure/drizzle-schedules.ts";
import {
  DrizzleWatcherQueries,
  DrizzleWatcherRepository,
} from "./infrastructure/drizzle-watchers.ts";

export type {
  CallerDirectory,
  DeliveryTrigger,
  EventSource,
  ScheduleFilter,
  ScheduleQueries,
  Send,
  WatcherQueries,
} from "./application/ports.ts";
export type {
  DeliveryReport,
  RegisterWatcherCommand,
  RemoveWatcherCommand,
  Watchers,
} from "./application/watchers.ts";
export type {
  CancelScheduleCommand,
  CreateScheduleCommand,
  FiringReport,
  Schedules,
} from "./application/schedules.ts";
export { invalidSchedule, scheduleNotFound, watcherNotFound } from "./domain/errors.ts";
export { MAX_WATCHERS_PER_VIBE, signDelivery } from "./domain/watcher.ts";
export {
  MIN_INTERVAL_MS,
  SCHEDULE_STATES,
  type ScheduleSnapshot,
  type ScheduleState,
  type Timing,
} from "./domain/schedule.ts";

export interface Automation {
  schedules: Schedules;
  queries: ScheduleQueries;
  watchers: Watchers;
  watcherQueries: WatcherQueries;
}

/**
 * Wires the Automation context: what the vibe does later, on someone's
 * behalf. It posts through Messaging, as a caller Identity finds again when
 * the time comes.
 */
export function createAutomation(deps: {
  db: Db;
  begin: BeginUnitOfWork;
  authorizer: Authorizer;
  actors: ActorDirectory;
  callers: CallerDirectory;
  messaging: Messaging;
  /** The event log, for watchers to read from their own place in it. */
  events: EventSource;
  /** How a watcher's endpoint is reached. `fetch`, when left out. */
  send?: Send | undefined;
  /** What runs a delivery pass later. Left out, deliveries go out only when a pass is called for. */
  deliveries?: DeliveryTrigger | undefined;
  clock?: Clock | undefined;
}): Automation {
  const clock = deps.clock ?? systemClock;
  return {
    watchers: new Watchers(
      new DrizzleWatcherRepository(deps.db),
      deps.events,
      deps.messaging.vibes,
      deps.callers,
      deps.authorizer,
      deps.actors,
      deps.begin,
      clock,
      deps.send ?? ((url, init) => fetch(url, init)),
      deps.deliveries,
    ),
    watcherQueries: new DrizzleWatcherQueries(deps.db),
    schedules: new Schedules(
      new DrizzleScheduleRepository(deps.db),
      deps.messaging.postMessage,
      deps.messaging.vibes,
      deps.callers,
      deps.authorizer,
      deps.actors,
      deps.begin,
      clock,
    ),
    queries: new DrizzleScheduleQueries(deps.db),
  };
}
