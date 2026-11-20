import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";

import { effective, MAX_LEASE_MS, Task, type Worker } from "./task.ts";

const person = (id: string): Worker => ({ actorId: id, principal: id, profile: null });
const agent = (of: string, profile: string): Worker => ({
  actorId: `${of}+${profile}`,
  principal: of,
  profile,
});
const ada = person("vibe:user:u_ada");
const bob = person("vibe:user:u_bob");
const lead = agent(ada.principal, "lead");
const fixer = agent(ada.principal, "fixer");

const create = (over: Partial<Parameters<typeof Task.create>[0]> = {}) => {
  const task = Task.create({
    id: "msg_1",
    vibeId: "vb_1",
    channel: "work",
    owner: lead.actorId,
    now: 1000,
    ...over,
  });
  task.pullEvents();
  return task;
};
const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
};
const types = (task: Task) => task.pullEvents().map((event) => event.type);

describe("a task", () => {
  test("is ready when created, or waiting while a task it needs hasn't completed", () => {
    const ready = Task.create({
      id: "msg_1",
      vibeId: "vb_1",
      channel: "work",
      owner: ada.actorId,
      now: 1,
    });
    expect(ready.snapshot.state).toBe("ready");
    expect(ready.pullEvents()).toMatchObject([
      {
        type: "task.created",
        actorId: ada.actorId,
        state: "ready",
        payload: { for: null, needs: [] },
      },
    ]);

    const waiting = create({ needs: ["msg_0", "msg_0"], unmet: true });
    expect(waiting.snapshot).toMatchObject({ state: "waiting", needs: ["msg_0"] });
    expect(code(() => create({ needs: ["msg_1"] }))).toBe("invalid_needs");
  });

  test("goes to one worker for a lease, and to no second worker while it runs", () => {
    const task = create();
    const claim = task.claim({ by: fixer, claimId: "clm_1", now: 2000 });
    expect(claim).toEqual({ id: "clm_1", by: fixer.actorId, expiresAt: 2000 + MAX_LEASE_MS });
    expect(task.snapshot.state).toBe("claimed");
    expect(code(() => task.claim({ by: bob, claimId: "clm_2", now: 3000 }))).toBe("task_claimed");
    expect(types(task)).toEqual(["task.claimed"]);
  });

  test("is ready for another worker once the lease runs out, and the old claim changes nothing", () => {
    const task = create();
    task.claim({ by: fixer, claimId: "clm_1", leaseMs: 10_000, now: 2000 });
    task.pullEvents();

    const late = 12_000;
    expect(effective(task.snapshot, late)).toMatchObject({ state: "ready", claim: null });
    for (const stale of [
      () => task.renew({ by: fixer, claimId: "clm_1", now: late }),
      () => task.complete({ by: fixer, claimId: "clm_1", now: late }),
      () => task.fail({ by: fixer, claimId: "clm_1", reason: "x", now: late }),
      () => task.release({ by: fixer, claimId: "clm_1", now: late }),
      () => task.block({ by: fixer, claimId: "clm_1", reason: "x", now: late }),
    ]) {
      expect(code(stale)).toBe("claim_lost");
    }
    expect(task.snapshot.state).toBe("claimed");

    task.claim({ by: bob, claimId: "clm_2", now: late });
    expect(types(task)).toEqual(["task.expired", "task.claimed"]);
    expect(code(() => task.complete({ by: fixer, claimId: "clm_1", now: late + 1 }))).toBe(
      "claim_lost",
    );
    expect(task.snapshot.claim?.by).toBe(bob.actorId);
  });

  test("a claim is its holder's: another principal can't use its ID", () => {
    const task = create();
    task.claim({ by: fixer, claimId: "clm_1", now: 2000 });
    expect(code(() => task.complete({ by: bob, claimId: "clm_1", now: 2001 }))).toBe("claim_lost");
    expect(code(() => task.complete({ by: fixer, claimId: "clm_x", now: 2001 }))).toBe(
      "claim_lost",
    );
  });

  test("a renewal extends the lease from now", () => {
    const task = create();
    task.claim({ by: fixer, claimId: "clm_1", leaseMs: 10_000, now: 2000 });
    const renewed = task.renew({ by: fixer, claimId: "clm_1", leaseMs: 10_000, now: 9000 });
    expect(renewed.expiresAt).toBe(19_000);
    expect(code(() => task.claim({ by: bob, claimId: "clm_2", now: 15_000 }))).toBe("task_claimed");
    expect(code(() => task.renew({ by: fixer, claimId: "clm_1", leaseMs: 1, now: 9001 }))).toBe(
      "invalid_task",
    );
  });

  test("is settled by its holder: completed, failed, or released", () => {
    const done = create();
    done.claim({ by: fixer, claimId: "c", now: 2000 });
    done.complete({ by: fixer, claimId: "c", result: " fixed in a1b2c3 ", now: 2500 });
    expect(done.snapshot).toMatchObject({
      state: "completed",
      claim: null,
      result: "fixed in a1b2c3",
    });
    expect(code(() => done.claim({ by: bob, claimId: "d", now: 3000 }))).toBe("task_finished");

    const failed = create();
    failed.claim({ by: fixer, claimId: "c", now: 2000 });
    expect(code(() => failed.fail({ by: fixer, claimId: "c", reason: " ", now: 2500 }))).toBe(
      "invalid_task",
    );
    failed.fail({ by: fixer, claimId: "c", reason: "tests fail", now: 2500 });
    expect(failed.snapshot).toMatchObject({ state: "failed", reason: "tests fail" });

    const released = create();
    released.claim({ by: fixer, claimId: "c", now: 2000 });
    released.release({ by: fixer, claimId: "c", now: 2500 });
    expect(released.snapshot).toMatchObject({ state: "ready", claim: null });
    expect(types(released)).toEqual(["task.claimed", "task.released"]);
  });

  test("a failed task is reopened in place by its owner", () => {
    const task = create();
    expect(code(() => task.reopen({ by: lead, unmet: false, now: 1500 }))).toBe("task_not_failed");
    task.claim({ by: fixer, claimId: "c", now: 2000 });
    task.fail({ by: fixer, claimId: "c", reason: "flaky", now: 2500 });

    expect(code(() => task.reopen({ by: fixer, unmet: false, now: 3000 }))).toBe("task_not_owned");
    task.reopen({ by: lead, unmet: false, now: 3000 });
    expect(task.snapshot).toMatchObject({ state: "ready", reason: null });
  });
});

describe("who manages a task", () => {
  test("its owner, a person for their profiles' tasks, or someone who manages the channel", () => {
    const attempt = (by: Worker, manager = false) =>
      code(() => create().cancel({ by, manager, reason: "superseded", now: 2000 }));

    expect(attempt(lead)).toBeNull();
    expect(attempt(ada)).toBeNull();
    expect(attempt(fixer)).toBe("task_not_owned");
    expect(attempt(bob)).toBe("task_not_owned");
    expect(attempt(bob, true)).toBeNull();
  });

  test("a task kept for a profile goes only to that profile of its owner", () => {
    const task = create({ assignee: "fixer" });
    expect(code(() => task.claim({ by: lead, claimId: "c", now: 2000 }))).toBe("task_assigned");
    expect(
      code(() => task.claim({ by: agent(bob.principal, "fixer"), claimId: "c", now: 2000 })),
    ).toBe("task_assigned");
    expect(code(() => task.claim({ by: fixer, claimId: "c", now: 2000 }))).toBeNull();

    const pooled = create({ assignee: "fixer" });
    pooled.assign({ by: lead, profile: null, now: 1500 });
    expect(code(() => pooled.claim({ by: bob, claimId: "c", now: 2000 }))).toBeNull();
    expect(types(pooled)).toEqual(["task.assigned", "task.claimed"]);
  });

  test("a hold ends any claim, and is lifted by the owner to ready or to waiting", () => {
    const byWorker = create();
    byWorker.claim({ by: fixer, claimId: "c", now: 2000 });
    byWorker.block({
      by: fixer,
      claimId: "c",
      reason: "approve the prod deploy?",
      kind: "awaiting_approval",
      now: 2500,
    });
    expect(byWorker.snapshot).toMatchObject({
      state: "blocked",
      claim: null,
      hold: { kind: "awaiting_approval", reason: "approve the prod deploy?" },
    });
    expect(code(() => byWorker.claim({ by: bob, claimId: "d", now: 3000 }))).toBe("task_blocked");
    expect(code(() => byWorker.unblock({ by: fixer, unmet: false, now: 3000 }))).toBe(
      "task_not_owned",
    );
    byWorker.unblock({ by: lead, unmet: false, now: 3000 });
    expect(byWorker.snapshot).toMatchObject({ state: "ready", hold: null });

    const byOwner = create();
    byOwner.claim({ by: fixer, claimId: "c", now: 2000 });
    expect(code(() => byOwner.block({ by: bob, reason: "wait", now: 2500 }))).toBe(
      "task_not_owned",
    );
    byOwner.block({ by: lead, reason: "wait", now: 2500 });
    expect(code(() => byOwner.complete({ by: fixer, claimId: "c", now: 2600 }))).toBe("claim_lost");
    byOwner.unblock({ by: lead, unmet: true, now: 3000 });
    expect(byOwner.snapshot.state).toBe("waiting");
    expect(code(() => byOwner.unblock({ by: lead, unmet: false, now: 3100 }))).toBe(
      "task_not_blocked",
    );
    expect(code(() => create().block({ by: lead, reason: "x", kind: "Not A Kind", now: 1 }))).toBe(
      "invalid_task",
    );
  });

  test("what it waits for changes only while no one holds it, and decides waiting or ready", () => {
    const task = create();
    task.setNeeds({ by: lead, needs: ["msg_0"], unmet: true, now: 1500 });
    expect(task.snapshot).toMatchObject({ state: "waiting", needs: ["msg_0"] });
    expect(task.needsDirty).toBe(true);
    expect(code(() => task.claim({ by: fixer, claimId: "c", now: 2000 }))).toBe("task_waiting");

    expect(task.promote({ actorId: bob.actorId, now: 2500 })).toBe(true);
    expect(task.promote({ actorId: bob.actorId, now: 2600 })).toBe(false);
    task.claim({ by: fixer, claimId: "c", now: 3000 });
    expect(code(() => task.setNeeds({ by: lead, needs: [], unmet: false, now: 3500 }))).toBe(
      "task_claimed",
    );
    expect(
      code(() => create().setNeeds({ by: lead, needs: ["msg_1"], unmet: false, now: 1 })),
    ).toBe("invalid_needs");
  });

  test("canceling ends it for good", () => {
    const task = create();
    task.claim({ by: fixer, claimId: "c", now: 2000 });
    task.cancel({ by: lead, reason: "superseded by the nightly deploy", now: 2500 });
    expect(task.snapshot).toMatchObject({ state: "canceled", claim: null });
    expect(code(() => task.complete({ by: fixer, claimId: "c", now: 2600 }))).toBe("claim_lost");
    expect(code(() => task.cancel({ by: lead, reason: "again", now: 2700 }))).toBe("task_finished");
    expect(code(() => task.reopen({ by: lead, unmet: false, now: 2800 }))).toBe("task_finished");
  });
});

describe("a task and its root message", () => {
  test("deleting the root cancels the task, unless it already ended", () => {
    const open = create();
    expect(open.rootDeleted({ actorId: ada.actorId, now: 2000 })).toBe(true);
    expect(open.snapshot.state).toBe("canceled");

    const done = create();
    done.claim({ by: fixer, claimId: "c", now: 2000 });
    done.complete({ by: fixer, claimId: "c", now: 2500 });
    expect(done.rootDeleted({ actorId: ada.actorId, now: 3000 })).toBe(false);
    expect(done.snapshot.state).toBe("completed");
  });

  test("an edit by someone other than the owner holds the task", () => {
    const own = create();
    expect(own.rootEdited({ by: lead, now: 2000 })).toBe(false);
    expect(own.rootEdited({ by: ada, now: 2000 })).toBe(false);

    const adopted = create({ owner: bob.actorId });
    adopted.claim({ by: fixer, claimId: "c", now: 2000 });
    expect(adopted.rootEdited({ by: ada, now: 2500 })).toBe(true);
    expect(adopted.snapshot).toMatchObject({
      state: "blocked",
      claim: null,
      hold: { kind: "text_changed" },
    });
  });
});
