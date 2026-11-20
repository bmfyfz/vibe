import { principalOf } from "@vibe/kernel";

import {
  claimLost,
  invalidNeeds,
  invalidTask,
  taskAssigned,
  taskBlocked,
  taskClaimed,
  taskFinished,
  taskNotBlocked,
  taskNotFailed,
  taskNotOwned,
  taskWaiting,
} from "./errors.ts";

/** The vibe's own label that mirrors a task's state on its root, to filter on and wait for. */
export const TASK_LABEL = "vibe.task";

export const OPEN_STATES = ["waiting", "ready", "claimed", "blocked"] as const;
export const FINISHED_STATES = ["completed", "failed", "canceled"] as const;
export const TASK_STATES = [...OPEN_STATES, ...FINISHED_STATES] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** A claim's lease lasts up to this long. A worker that needs longer renews it. */
export const MAX_LEASE_MS = 5 * 60_000;
export const MIN_LEASE_MS = 1_000;
/** How much a result, a reason or a hold's reason can say. Longer detail belongs in the thread. */
export const MAX_NOTE_LENGTH = 2_000;
/** How many tasks one task can wait for. */
export const MAX_NEEDS = 20;

const HOLD_KIND = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A lease on a task: one worker's for a limited time, so a worker that stalls doesn't keep it. */
export interface Claim {
  /** What the holder shows to renew or settle. Never recorded in an event. */
  readonly id: string;
  /** The actor that holds the task. */
  readonly by: string;
  readonly expiresAt: number;
}

/** Why a task is held for a person. */
export interface Hold {
  /** What the hold is for, in the holder's words: `needs_input`, `awaiting_approval`. */
  readonly kind: string;
  readonly reason: string;
}

export interface TaskSnapshot {
  /** The ID of the thread's root message. A task is a thread. */
  readonly id: string;
  readonly vibeId: string;
  readonly channel: string;
  /** The actor that made the thread a task. */
  readonly owner: string;
  readonly state: TaskState;
  /** The one profile of the owner's principal that can claim it, or `null` for anyone who can. */
  readonly assignee: string | null;
  readonly claim: Claim | null;
  readonly hold: Hold | null;
  /** The tasks this one waits for. */
  readonly needs: readonly string[];
  /** How it completed. */
  readonly result: string | null;
  /** Why it failed or was canceled. */
  readonly reason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Who acts on a task: an actor, and the principal it acts for. */
export interface Worker {
  readonly actorId: string;
  readonly principal: string;
  readonly profile: string | null;
}

export type TaskEventType =
  | "task.created"
  | "task.ready"
  | "task.claimed"
  | "task.renewed"
  | "task.released"
  | "task.completed"
  | "task.failed"
  | "task.blocked"
  | "task.unblocked"
  | "task.canceled"
  | "task.reopened"
  | "task.assigned"
  | "task.needs_changed"
  | "task.expired";

export interface TaskEvent {
  readonly type: TaskEventType;
  readonly actorId: string;
  /** The task's state once this has happened. */
  readonly state: TaskState;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A change only the task's owner, or someone who manages its channel, may make. */
interface Managing {
  by: Worker;
  /** Whether `by` holds `manage` in the task's channel. */
  manager?: boolean | undefined;
  now: number;
}

/** A change only the worker that holds the task may make, while its lease lasts. */
interface Holding {
  by: Worker;
  claimId: string;
  now: number;
}

/**
 * A thread that someone's agents are to do, with a state the vibe keeps: who
 * can claim it, who holds it, what it waits for and how it ended.
 *
 * Whether the tasks it waits for have completed is not something a task knows.
 * Commands that need it are told, as `unmet`.
 */
export class Task {
  private pending: TaskEvent[] = [];
  private needsChanged = false;

  private constructor(
    private state: TaskSnapshot,
    /** Whether this task has never been stored. */
    readonly isNew: boolean,
  ) {}

  /** Makes a thread a task. Whoever does owns it. */
  static create(input: {
    id: string;
    vibeId: string;
    channel: string;
    owner: string;
    assignee?: string | null | undefined;
    needs?: readonly string[] | undefined;
    /** Whether any of `needs` hasn't completed. */
    unmet?: boolean | undefined;
    now: number;
  }): Task {
    const needs = uniqueNeeds(input.id, input.needs ?? []);
    const task = new Task(
      {
        id: input.id,
        vibeId: input.vibeId,
        channel: input.channel,
        owner: input.owner,
        state: input.unmet === true ? "waiting" : "ready",
        assignee: input.assignee ?? null,
        claim: null,
        hold: null,
        needs,
        result: null,
        reason: null,
        createdAt: input.now,
        updatedAt: input.now,
      },
      true,
    );
    task.needsChanged = needs.length > 0;
    task.record("task.created", input.owner, { for: task.state.assignee, needs });
    return task;
  }

  static rehydrate(snapshot: TaskSnapshot): Task {
    return new Task(snapshot, false);
  }

  /**
   * Gives the task to a worker for a lease.
   *
   * @throws `task_claimed` when another worker's lease still runs, `task_assigned`
   *   when it is kept for another profile, and `task_waiting`, `task_blocked` or
   *   `task_finished` by its state.
   */
  claim(input: { by: Worker; claimId: string; leaseMs?: number | undefined; now: number }): Claim {
    this.expireIfDue(input.now);
    const { state, assignee, owner } = this.state;
    if (isFinished(state)) throw taskFinished(state);
    if (state === "blocked") throw taskBlocked();
    if (state === "waiting") throw taskWaiting();
    if (state === "claimed") throw taskClaimed();
    if (assignee !== null) {
      const { by } = input;
      if (by.profile !== assignee || by.principal !== principalOf(owner)) {
        throw taskAssigned(assignee);
      }
    }

    const claim: Claim = {
      id: input.claimId,
      by: input.by.actorId,
      expiresAt: input.now + leaseOf(input.leaseMs),
    };
    this.change({ state: "claimed", claim }, input.now);
    this.record("task.claimed", claim.by, { leaseExpiresAt: iso(claim.expiresAt) });
    return claim;
  }

  /** Extends the holder's lease, counted from now. */
  renew(input: Holding & { leaseMs?: number | undefined }): Claim {
    const held = this.held(input);
    const claim: Claim = { ...held, expiresAt: input.now + leaseOf(input.leaseMs) };
    this.change({ claim }, input.now);
    this.record("task.renewed", claim.by, { leaseExpiresAt: iso(claim.expiresAt) });
    return claim;
  }

  /** Returns the task to the queue, undone. */
  release(input: Holding): void {
    const { by } = this.held(input);
    this.change({ state: "ready", claim: null }, input.now);
    this.record("task.released", by, {});
  }

  complete(input: Holding & { result?: string | undefined }): void {
    const { by } = this.held(input);
    const result = note(input.result ?? "", "result") || null;
    this.change({ state: "completed", claim: null, result }, input.now);
    this.record("task.completed", by, { result });
  }

  /** Gives up on the task. Its owner can reopen it. */
  fail(input: Holding & { reason: string }): void {
    const { by } = this.held(input);
    const reason = required(input.reason, "reason");
    this.change({ state: "failed", claim: null, reason }, input.now);
    this.record("task.failed", by, { reason });
  }

  /**
   * Holds the task until a person answers. The worker that holds it blocks it
   * with its claim, which ends the claim. Its owner can hold it at any time,
   * which ends whatever claim there is.
   */
  block(input: {
    by: Worker;
    claimId?: string | undefined;
    manager?: boolean | undefined;
    reason: string;
    kind?: string | undefined;
    now: number;
  }): void {
    const kind = input.kind ?? "needs_input";
    if (!HOLD_KIND.test(kind)) {
      throw invalidTask(
        `"${kind}" is not a kind of hold.`,
        "Use up to 64 lowercase letters, numbers, _ and -, such as awaiting_approval.",
      );
    }
    const reason = required(input.reason, "reason");
    if (input.claimId !== undefined) {
      this.held({ by: input.by, claimId: input.claimId, now: input.now });
    } else {
      this.expireIfDue(input.now);
      this.managed(input);
      if (isFinished(this.state.state)) throw taskFinished(this.state.state);
    }
    this.change({ state: "blocked", claim: null, hold: { kind, reason } }, input.now);
    this.record("task.blocked", input.by.actorId, { kind, reason });
  }

  /** Lifts a hold. The task is ready again, or waiting while a task it needs hasn't completed. */
  unblock(input: Managing & { unmet: boolean }): void {
    this.managed(input);
    if (isFinished(this.state.state)) throw taskFinished(this.state.state);
    if (this.state.state !== "blocked") throw taskNotBlocked();
    this.change({ state: input.unmet ? "waiting" : "ready", hold: null }, input.now);
    this.record("task.unblocked", input.by.actorId, {});
  }

  /** Makes a failed task ready again, in place, so what waits for it keeps waiting. */
  reopen(input: Managing & { unmet: boolean }): void {
    this.managed(input);
    if (this.state.state !== "failed") {
      throw isFinished(this.state.state) ? taskFinished(this.state.state) : taskNotFailed();
    }
    this.change({ state: input.unmet ? "waiting" : "ready", reason: null }, input.now);
    this.record("task.reopened", input.by.actorId, {});
  }

  /** Keeps the task for one profile of its owner, or with `null` returns it to anyone who can claim it. */
  assign(input: Managing & { profile: string | null }): void {
    this.expireIfDue(input.now);
    this.managed(input);
    if (isFinished(this.state.state)) throw taskFinished(this.state.state);
    if (this.state.assignee === input.profile) return;
    this.change({ assignee: input.profile }, input.now);
    this.record("task.assigned", input.by.actorId, { for: input.profile });
  }

  /** Replaces what the task waits for. Only while no one holds it and it isn't finished. */
  setNeeds(input: Managing & { needs: readonly string[]; unmet: boolean }): void {
    this.expireIfDue(input.now);
    this.managed(input);
    const { state } = this.state;
    if (isFinished(state)) throw taskFinished(state);
    if (state === "claimed") throw taskClaimed();

    const needs = uniqueNeeds(this.state.id, input.needs);
    const next = state === "blocked" ? state : input.unmet ? "waiting" : "ready";
    this.needsChanged = true;
    this.change({ needs, state: next }, input.now);
    this.record("task.needs_changed", input.by.actorId, { needs });
  }

  /** Calls the task off. */
  cancel(input: Managing & { reason: string }): void {
    this.managed(input);
    if (isFinished(this.state.state)) throw taskFinished(this.state.state);
    const reason = required(input.reason, "reason");
    this.change({ state: "canceled", claim: null, hold: null, reason }, input.now);
    this.record("task.canceled", input.by.actorId, { reason });
  }

  /** Ends a claim whose lease has run out, so the task is ready for another worker. */
  expire(input: { now: number }): boolean {
    return this.expireIfDue(input.now);
  }

  /** Readies a waiting task once every task it needed has completed. */
  promote(input: { actorId: string; now: number }): boolean {
    if (this.state.state !== "waiting") return false;
    this.change({ state: "ready" }, input.now);
    this.record("task.ready", input.actorId, {});
    return true;
  }

  /** Deleting a task's root cancels the task, unless it already ended. */
  rootDeleted(input: { actorId: string; now: number }): boolean {
    if (isFinished(this.state.state)) return false;
    const reason = "Its root message was deleted.";
    this.change({ state: "canceled", claim: null, hold: null, reason }, input.now);
    this.record("task.canceled", input.actorId, { reason });
    return true;
  }

  /**
   * A task's text is instructions for whoever claims it. When someone other
   * than its owner changes that text, the task is held, so its owner can read
   * the new text and then unblock or cancel it.
   */
  rootEdited(input: { by: Worker; now: number }): boolean {
    if (isFinished(this.state.state) || this.owns(input.by)) return false;
    const hold: Hold = {
      kind: "text_changed",
      reason: "Someone other than the task's owner edited its text.",
    };
    this.change({ state: "blocked", claim: null, hold }, input.now);
    this.record("task.blocked", input.by.actorId, { ...hold });
    return true;
  }

  get id(): string {
    return this.state.id;
  }

  get snapshot(): TaskSnapshot {
    return this.state;
  }

  /** Whether the stored list of what it waits for is out of date. */
  get needsDirty(): boolean {
    return this.needsChanged;
  }

  /** Hands over what happened since the task was loaded. */
  pullEvents(): TaskEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }

  private change(next: Partial<TaskSnapshot>, now: number): void {
    this.state = { ...this.state, ...next, updatedAt: now };
  }

  private record(type: TaskEventType, actorId: string, payload: Record<string, unknown>): void {
    this.pending.push({ type, actorId, state: this.state.state, payload });
  }

  private expireIfDue(now: number): boolean {
    const { state, claim } = this.state;
    if (state !== "claimed" || claim === null || now < claim.expiresAt) return false;
    this.change({ state: "ready", claim: null }, now);
    this.record("task.expired", claim.by, {});
    return true;
  }

  /** The claim, when the worker still holds it. A claim that is over changes nothing. */
  private held(input: Holding): Claim {
    const { state, claim } = this.state;
    const holds =
      state === "claimed" &&
      claim !== null &&
      claim.id === input.claimId &&
      principalOf(claim.by) === input.by.principal &&
      input.now < claim.expiresAt;
    if (!holds) throw claimLost();
    return claim;
  }

  /**
   * A profile owns only the tasks it created. A principal acting as itself
   * manages what any of its profiles created.
   */
  private owns(by: Worker): boolean {
    const { owner } = this.state;
    return owner === by.actorId || (by.profile === null && principalOf(owner) === by.principal);
  }

  private managed(input: { by: Worker; manager?: boolean | undefined }): void {
    if (input.manager !== true && !this.owns(input.by)) throw taskNotOwned();
  }
}

export function isFinished(state: TaskState): boolean {
  return (FINISHED_STATES as readonly string[]).includes(state);
}

/**
 * What a reader is shown: a claim whose lease has run out no longer holds the
 * task, whether or not the sweep has recorded that yet.
 */
export function effective(snapshot: TaskSnapshot, now: number): TaskSnapshot {
  const { state, claim } = snapshot;
  if (state !== "claimed" || claim === null || now < claim.expiresAt) return snapshot;
  return { ...snapshot, state: "ready", claim: null };
}

function leaseOf(requested: number | undefined): number {
  if (requested === undefined) return MAX_LEASE_MS;
  if (!Number.isFinite(requested) || requested < MIN_LEASE_MS || requested > MAX_LEASE_MS) {
    throw invalidTask(
      "A lease lasts from 1 second to 5 minutes.",
      "Take a lease in that range and renew it to keep the task.",
    );
  }
  return Math.floor(requested);
}

function uniqueNeeds(id: string, needs: readonly string[]): string[] {
  const unique = [...new Set(needs)];
  if (unique.includes(id)) throw invalidNeeds("A task can't wait for itself.");
  if (unique.length > MAX_NEEDS) throw invalidNeeds(`A task waits for up to ${MAX_NEEDS} tasks.`);
  return unique;
}

function note(text: string, what: string): string {
  const trimmed = text.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw invalidTask(
      `A ${what} holds up to ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters.`,
      "Put the detail in a reply in the task's thread.",
    );
  }
  return trimmed;
}

function required(text: string, what: string): string {
  const trimmed = note(text, what);
  if (trimmed === "") throw invalidTask(`This needs a ${what}.`);
  return trimmed;
}

function iso(time: number): string {
  return new Date(time).toISOString();
}
