import { describe, expect, test } from "bun:test";

import type { ActorDirectory, Authorizer, Caller } from "@vibe/identity";
import type { PostMessage, PostMessageCommand, VibeRecord } from "@vibe/messaging";
import { beginUnitOfWork, createDb } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";

import { DrizzleScheduleRepository } from "../infrastructure/drizzle-schedules.ts";
import type { ScheduleRepository } from "./ports.ts";
import { Schedules } from "./schedules.ts";

const MINUTE = 60_000;
const vibe: VibeRecord = { id: "vb_1", teamId: "team_1", name: "general", createdAt: 0 };
const ada: Caller = {
  actorId: "vibe:user:u_ada",
  principal: "vibe:user:u_ada",
  profile: null,
  teamId: "team_1",
  teamName: "default",
  handle: "ada",
  name: "ada",
  role: "member",
  narrowed: null,
  credential: null,
};

/**
 * The schedules service on a real store, with everything around it stood in
 * for: a poster that only records what it was asked to post, and an
 * authorizer that allows everything.
 */
function setup(wrap: (repository: ScheduleRepository) => ScheduleRepository = (r) => r) {
  const db = createDb(bunSqliteExecutor(openDatabase()));
  const clock = { at: 1_000_000_000, now: () => clock.at };
  const posted: PostMessageCommand[] = [];
  const poster = {
    rehearse: async (command: PostMessageCommand) => ({
      channel: command.channel ?? "dev",
      threadId: null,
      replyTo: null,
    }),
    execute: async (command: PostMessageCommand) => {
      posted.push(command);
      return { messageId: `msg_${posted.length}`, created: true, unresolved: [] };
    },
  } as unknown as PostMessage;
  const all = new Set(["read", "post", "react", "label", "sync", "manage"] as const);
  const authorizer = { permissions: async () => all } as unknown as Authorizer;
  const actors: ActorDirectory = { introduce: () => {} };
  const repository = new DrizzleScheduleRepository(db);
  const schedules = new Schedules(
    wrap(repository),
    poster,
    { find: async () => vibe },
    { callerOf: async () => ada },
    authorizer,
    actors,
    beginUnitOfWork(db),
    clock,
  );
  return { schedules, repository, posted, clock };
}

describe("firing what is due", () => {
  test("a schedule canceled after the pass listed it does not post", async () => {
    let cancel: (() => Promise<unknown>) | undefined;
    // A pass whose list is already stale when it comes to use it: the cancel
    // lands between the list and the schedule's turn.
    const { schedules, repository, posted, clock } = setup((real) => ({
      find: (vibeId, id) => real.find(vibeId, id),
      add: (uow, schedule) => real.add(uow, schedule),
      save: (uow, schedule, was) => real.save(uow, schedule, was),
      async due(now, limit) {
        const listed = await real.due(now, limit);
        await cancel?.();
        return listed;
      },
    }));
    const id = await schedules.create({
      caller: ada,
      vibe,
      channel: "dev",
      text: "standup",
      timing: { every: MINUTE },
    });
    cancel = () => schedules.cancel({ caller: ada, vibe, id });

    clock.at += MINUTE;
    expect(await schedules.fireDue()).toEqual({ fired: 0, stopped: 0, failed: 0 });
    expect(posted).toEqual([]);
    expect((await repository.find(vibe.id, id))?.snapshot).toMatchObject({
      state: "canceled",
      runs: 0,
    });
  });

  test("a schedule another pass already fired does not post again", async () => {
    let other: (() => Promise<unknown>) | undefined;
    const { schedules, repository, posted, clock } = setup((real) => ({
      find: (vibeId, id) => real.find(vibeId, id),
      add: (uow, schedule) => real.add(uow, schedule),
      save: (uow, schedule, was) => real.save(uow, schedule, was),
      async due(now, limit) {
        const listed = await real.due(now, limit);
        const overlapping = other;
        other = undefined;
        await overlapping?.();
        return listed;
      },
    }));
    const id = await schedules.create({
      caller: ada,
      vibe,
      channel: "dev",
      text: "standup",
      timing: { every: MINUTE },
    });
    other = () => schedules.fireDue();

    clock.at += MINUTE;
    expect(await schedules.fireDue()).toEqual({ fired: 0, stopped: 0, failed: 0 });
    expect(posted.map((command) => command.idempotencyKey)).toEqual([`${id}:1`]);
    expect((await repository.find(vibe.id, id))?.snapshot.runs).toBe(1);
  });

  test("each firing posts as the author, under a key of its own", async () => {
    const { schedules, posted, clock } = setup();
    const id = await schedules.create({
      caller: ada,
      vibe,
      channel: "dev",
      text: "standup",
      labels: { kind: "ritual" },
      timing: { every: MINUTE, times: 2 },
    });
    for (const _ of [1, 2, 3]) {
      clock.at += MINUTE;
      await schedules.fireDue();
    }
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({
      caller: ada,
      vibe,
      channel: "dev",
      text: "standup",
      labels: { kind: "ritual" },
      idempotencyKey: `${id}:1`,
    });
    expect(posted[1]?.idempotencyKey).toBe(`${id}:2`);
  });
});
