import { type Clock, type EventLog, type Sleep, sleep, systemClock } from "@vibe/kernel";
import type { Db } from "@vibe/store";

import { ActivityService } from "./application/activity-service.ts";
import type { Hub } from "./application/ports.ts";
import { DrizzleEventLog } from "./infrastructure/drizzle-event-log.ts";

export type { PollQuery } from "./application/activity-service.ts";
export { ActivityService } from "./application/activity-service.ts";
export type { EventFilter, Hub } from "./application/ports.ts";
export { decodeCursor, encodeCursor } from "./domain/cursor.ts";

export interface Activity {
  /** The write side, which every other context appends to. */
  eventLog: EventLog;
  service: ActivityService;
}

/** Wires the Activity context to a database. */
export function createActivity(deps: {
  db: Db;
  /** Where live clients listen, when the runtime has such a place. */
  hub?: Hub | undefined;
  clock?: Clock | undefined;
  sleep?: Sleep | undefined;
  pollIntervalMs?: number | undefined;
}): Activity {
  const log = new DrizzleEventLog(deps.db, deps.hub);
  return {
    eventLog: log,
    service: new ActivityService(
      log,
      deps.clock ?? systemClock,
      deps.sleep ?? sleep,
      deps.pollIntervalMs ?? 1000,
    ),
  };
}
