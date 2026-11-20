import { describe, expect, test } from "bun:test";

import type { EventRecord } from "@vibe/kernel";
import { beginUnitOfWork, createDb } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";

import { DrizzleEventLog } from "./drizzle-event-log.ts";

function setup() {
  const db = createDb(bunSqliteExecutor(openDatabase()));
  const pokes: [vibeId: string, seq: number][] = [];
  const log = new DrizzleEventLog(db, { poke: (vibeId, seq) => pokes.push([vibeId, seq]) });
  return { log, pokes, begin: beginUnitOfWork(db) };
}

const event = (vibeId: string, threadId: string, threadVersion: number): EventRecord => ({
  vibeId,
  type: "message.posted",
  channel: "dev",
  threadId,
  threadVersion,
  messageId: null,
  actorId: "vibe:user:u_1",
  payload: {},
  facets: null,
  createdAt: 1,
});

describe("the event log's hub", () => {
  test("is told how far a vibe's log got, once, after the commit lands", async () => {
    const { log, pokes, begin } = setup();
    const uow = begin();
    log.append(uow, [event("vb_1", "msg_1", 1), event("vb_1", "msg_1", 2)]);
    expect(pokes).toEqual([]);

    await uow.commit();
    expect(pokes).toEqual([["vb_1", 2]]);
    expect(await log.head("vb_1")).toBe(2);
  });

  test("is told of each vibe a commit appended to, with that vibe's own place", async () => {
    const { log, pokes, begin } = setup();
    const uow = begin();
    log.append(uow, [event("vb_1", "msg_1", 1), event("vb_2", "msg_2", 1)]);
    log.append(uow, [event("vb_1", "msg_1", 2)]);
    await uow.commit();
    expect(pokes.sort()).toEqual([
      ["vb_1", 1],
      ["vb_1", 3],
      ["vb_2", 2],
    ]);
  });

  test("hears nothing of a commit that lost its race", async () => {
    const { log, pokes, begin } = setup();
    const first = begin();
    log.append(first, [event("vb_1", "msg_1", 1)]);
    await first.commit();

    const stale = begin();
    log.append(stale, [event("vb_1", "msg_1", 1)]);
    const error = await stale.commit().catch((e) => e);
    expect(log.isVersionConflict(error)).toBe(true);
    expect(pokes).toEqual([["vb_1", 1]]);
  });
});
