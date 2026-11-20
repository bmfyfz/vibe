import { describe, expect, test } from "bun:test";

import { ALL_CHANNELS } from "@vibe/kernel";
import { beginUnitOfWork, createDb, schema } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";

import { Task } from "../domain/task.ts";
import { DrizzleTaskQueries } from "./drizzle-task-queries.ts";
import { DrizzleTaskRepository } from "./drizzle-task-repository.ts";

const NOW = 1_700_000_000_000;
const VIBE = "vb_1";
const ada = "vibe:user:u_ada";
const everywhere = { all: true, allows: () => true };

/**
 * A store with tasks that were all created in one millisecond, in separate
 * writes, under IDs that sort the opposite way to the order they went in.
 * Nothing but the order they were stored in can tell them apart.
 */
async function sameInstant(
  ids: readonly string[],
  channelOf: (id: string) => string = () => "work",
) {
  const db = createDb(bunSqliteExecutor(openDatabase()));
  const begin = beginUnitOfWork(db);
  const repository = new DrizzleTaskRepository(db);
  await db.insert(schema.actors).values({
    id: ada,
    teamId: "team_1",
    principal: ada,
    profile: null,
    handle: "ada",
    name: "Ada",
    createdAt: NOW,
  });

  for (const id of ids) {
    const channel = channelOf(id);
    await db.insert(schema.threads).values({
      id,
      vibeId: VIBE,
      channel,
      version: 2,
      lastMessageId: id,
      lastActivityAt: NOW,
      createdAt: NOW,
    });
    await db.insert(schema.messages).values({
      id,
      threadId: id,
      vibeId: VIBE,
      actorId: ada,
      text: id,
      position: 1,
      createdAt: NOW,
    });
    const uow = begin();
    repository.save(uow, Task.create({ id, vibeId: VIBE, channel, owner: ada, now: NOW }));
    await uow.commit();
  }
  return { repository, queries: new DrizzleTaskQueries(db) };
}

describe("tasks created in the same millisecond", () => {
  const stored = ["msg_9", "msg_5", "msg_7", "msg_1", "msg_3"];

  test("are handed to workers in the order they were stored", async () => {
    const { repository } = await sameInstant(stored);
    const queue = await repository.claimable({
      vibeId: VIBE,
      channel: ALL_CHANNELS,
      labels: [],
      principal: ada,
      profile: null,
      from: [],
      now: NOW,
      limit: 25,
      offset: 0,
    });
    expect(queue.map((place) => place.id)).toEqual(stored);
  });

  test("are listed in the order they were stored", async () => {
    const { queries } = await sameInstant(stored);
    const filter = { channel: ALL_CHANNELS, states: null, limit: 10 };
    const all = await queries.list(VIBE, filter, everywhere, NOW);
    expect(all.map((detail) => detail.task.id)).toEqual(stored);
  });

  test("keep that order when a list takes more than one page to fill", async () => {
    // Sixty tasks, IDs descending, every other one in a channel the reader is
    // shut out of. A filtered reader is served pages of fifty, so the second
    // page has to pick up exactly where the first one ended.
    const many = Array.from({ length: 60 }, (_, n) => `msg_${String(99 - n).padStart(2, "0")}`);
    const closed = new Set(many.filter((_, n) => n % 2 === 1));
    const { queries } = await sameInstant(many, (id) => (closed.has(id) ? "closed" : "work"));

    const reader = { all: false, allows: (channel: string) => channel === "work" };
    const filter = { channel: ALL_CHANNELS, states: null, limit: 40 };
    const listed = await queries.list(VIBE, filter, reader, NOW);
    expect(listed.map((detail) => detail.task.id)).toEqual(many.filter((id) => !closed.has(id)));
  });
});
