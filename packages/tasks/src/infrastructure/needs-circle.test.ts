import { describe, expect, test } from "bun:test";

import type { Caller } from "@vibe/identity";
import { beginUnitOfWork, createDb } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";

import { Task } from "../domain/task.ts";
import { DrizzleTaskRepository } from "./drizzle-task-repository.ts";

const NOW = 1_700_000_000_000;
const VIBE = "vb_1";
const ada: Caller = {
  actorId: "vibe:user:u_ada",
  principal: "vibe:user:u_ada",
  profile: null,
  teamId: "team_1",
  teamName: "default",
  handle: "ada",
  name: "Ada",
  role: "owner",
  narrowed: null,
  credential: null,
};

/** A store with tasks that wait for nothing yet. */
async function tasksNamed(...ids: string[]) {
  const db = createDb(bunSqliteExecutor(openDatabase()));
  const begin = beginUnitOfWork(db);
  const repository = new DrizzleTaskRepository(db);
  for (const id of ids) {
    const uow = begin();
    repository.save(
      uow,
      Task.create({ id, vibeId: VIBE, channel: "work", owner: ada.actorId, now: NOW }),
    );
    await uow.commit();
  }
  /** Decides that a task waits for others, from what is stored now, and holds the commit back. */
  const decided = async (id: string, needs: string[]) => {
    const task = await repository.find(VIBE, id);
    if (!task) throw new Error(`There is no task ${id}.`);
    // The check every change makes: nothing it would wait for waits for it.
    expect(await repository.reaches(needs, id)).toBe(false);
    task.setNeeds({ by: ada, needs, unmet: true, manager: true, now: NOW });
    const uow = begin();
    repository.save(uow, task);
    return () => uow.commit();
  };
  return { repository, decided };
}

describe("tasks made to wait for each other at the same moment", () => {
  test("both pass the check, and only the first to commit lands", async () => {
    const { repository, decided } = await tasksNamed("msg_a", "msg_b");
    // Each is decided from a store in which the other waits for nothing.
    const commitA = await decided("msg_a", ["msg_b"]);
    const commitB = await decided("msg_b", ["msg_a"]);

    await commitA();
    const refused = await commitB().then(
      () => null,
      (error: unknown) => error,
    );
    // The second would close the circle. Its commit fails, whole, and says why.
    expect(repository.closedCircle(refused)).toBe(true);
    expect((await repository.find(VIBE, "msg_b"))?.snapshot.needs).toEqual([]);
    expect((await repository.find(VIBE, "msg_a"))?.snapshot.needs).toEqual(["msg_b"]);
    // Decided again, it is refused by the check itself.
    expect(await repository.reaches(["msg_a"], "msg_b")).toBe(true);
  });

  test("a circle of three is refused at the change that would close it", async () => {
    const { repository, decided } = await tasksNamed("msg_a", "msg_b", "msg_c");
    const commits = [
      await decided("msg_a", ["msg_b"]),
      await decided("msg_b", ["msg_c"]),
      await decided("msg_c", ["msg_a"]),
    ];
    const outcomes = [];
    for (const commit of commits) {
      outcomes.push(
        await commit().then(
          () => "landed",
          (error: unknown) => (repository.closedCircle(error) ? "refused" : String(error)),
        ),
      );
    }
    expect(outcomes).toEqual(["landed", "landed", "refused"]);
  });

  test("a change that closes no circle is not held up by the check", async () => {
    const { repository, decided } = await tasksNamed("msg_a", "msg_b", "msg_c");
    await (
      await decided("msg_a", ["msg_b", "msg_c"])
    )();
    await (
      await decided("msg_b", ["msg_c"])
    )();
    // Changing what a task waits for, to something else it may wait for.
    await (
      await decided("msg_a", ["msg_c"])
    )();
    expect((await repository.find(VIBE, "msg_a"))?.snapshot.needs).toEqual(["msg_c"]);
  });
});
