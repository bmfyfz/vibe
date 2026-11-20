import type {
  ClaimedTask,
  ClaimTaskRequest,
  ClaimTaskResponse,
  CreateTasksResponse,
  NewTask,
  RenewTaskResponse,
  TaskDetail,
  TasksPage,
  TaskState,
} from "@vibe/contracts";
import { MAX_TASKS_PER_WRITE, MAX_WAIT_SECONDS } from "@vibe/contracts/limits";

import { parseDuration, VibeError } from "./duration.ts";

/** Sends one request about this vibe's tasks and returns the parsed answer. */
export type TaskRequest = <T>(
  method: string,
  path: string,
  init?: {
    json?: unknown;
    query?: Record<string, string | number | readonly string[] | undefined>;
    signal?: AbortSignal | undefined;
  },
) => Promise<T>;

export interface TasksQuery {
  /** A channel, or a subtree such as `work/`. */
  channel?: string | undefined;
  /** One state, `open` (the default) for those still to settle, or `all`. */
  state?: TaskState | "open" | "all" | undefined;
  /** Owned by this actor: a handle, an actor ID, or `me`. */
  by?: string | undefined;
  /** Kept for this profile. */
  for?: string | undefined;
  /** Labels on the task's root, such as `{ step: "fix" }`. */
  label?: Record<string, string> | string[] | undefined;
  limit?: number | undefined;
}

export interface ReadyQuery {
  /** A channel, or a subtree such as `work/`. Every channel when left out. */
  channel?: string | undefined;
  /** Only tasks whose root has every one of these labels. This is how work is routed. */
  label?: Record<string, string> | string[] | undefined;
  /**
   * Also take tasks these actors own, by actor ID. A task's text is
   * instructions for whoever claims it, so without this a worker takes only
   * its own principal's tasks.
   */
  from?: string[] | undefined;
  /** How long to wait for a task to become ready: seconds, or a duration such as `10m`. */
  wait?: number | string | undefined;
}

export interface ClaimOptions {
  /** How long the lease lasts, in seconds, up to 300. Renew it to keep the task. */
  lease?: number | undefined;
  signal?: AbortSignal | undefined;
}

/** A task this handle holds, with the ways to keep it and to settle it. */
export interface TaskClaim extends ClaimedTask {
  /** Extends the lease from now, and returns when it now runs out. */
  renew(lease?: number): Promise<string>;
  /** Returns the task to the queue, undone. */
  release(): Promise<TaskDetail>;
  complete(result?: string): Promise<TaskDetail>;
  /** Gives up on the task. Its owner can reopen it. */
  fail(reason: string): Promise<TaskDetail>;
  /** Holds the task until a person answers in its thread. This ends the claim. */
  block(reason: string, options?: { kind?: string | undefined }): Promise<TaskDetail>;
}

/** A task to create. `needs` takes IDs of tasks that exist, or `{ key }` for one created alongside. */
export type TaskInput = NewTask;

/**
 * A vibe's tasks: threads that agents are to do, with a state the vibe keeps.
 * A task is still a thread, so reading, replying, labels and `wait` work on it
 * like on any other.
 */
export class VibeTasks {
  constructor(private readonly request: TaskRequest) {}

  /** Open tasks, oldest first: the order a queue works them in. */
  async list(query: TasksQuery = {}): Promise<TaskDetail[]> {
    const { channel, state, by, limit } = query;
    const page = await this.request<TasksPage>("GET", "/tasks", {
      query: { channel, state, by, for: query.for, limit, label: labelFilters(query.label) },
    });
    return page.tasks;
  }

  get(id: string): Promise<TaskDetail> {
    return this.request("GET", `/tasks/${encodeURIComponent(id)}`);
  }

  /** Starts a thread as a task. You own the tasks you create. */
  async create(
    channel: string,
    task: TaskInput | string,
    options: { idempotencyKey?: string | undefined } = {},
  ): Promise<TaskDetail> {
    const [created] = await this.createMany(
      channel,
      [typeof task === "string" ? { text: task } : task],
      options,
    );
    if (!created) throw new VibeError("task_not_found", "The task was not created.", 0);
    return created;
  }

  /**
   * Creates up to fifteen tasks in one write: all of them, or none. They may
   * wait for each other by `key`.
   *
   * @returns The tasks, in the order they were given.
   */
  async createMany(
    channel: string,
    tasks: readonly TaskInput[],
    options: { idempotencyKey?: string | undefined } = {},
  ): Promise<TaskDetail[]> {
    const response = await this.request<CreateTasksResponse>("POST", "/tasks", {
      json: { channel, tasks, idempotencyKey: options.idempotencyKey },
    });
    return response.tasks;
  }

  /**
   * Creates a plan of any length, in as many writes as it takes, each task
   * after the tasks it waits for. A ready task from an earlier write can be
   * claimed before a later one lands. With an idempotency key, running the
   * same plan again creates only what is missing.
   */
  async createPlan(
    channel: string,
    tasks: readonly TaskInput[],
    options: { idempotencyKey?: string | undefined } = {},
  ): Promise<TaskDetail[]> {
    const order = inDependencyOrder(tasks);
    const created = new Array<TaskDetail | undefined>(tasks.length);
    const idOfKey = new Map<string, string>();

    for (let from = 0, write = 0; from < order.length; from += MAX_TASKS_PER_WRITE, write++) {
      const places = order.slice(from, from + MAX_TASKS_PER_WRITE);
      const inThisWrite = new Set(places.map((place) => tasks[place]?.key));
      const chunk = places.flatMap((place) => {
        const task = tasks[place];
        if (!task) return [];
        // A task from an earlier write has an ID by now. One in this write goes by its key.
        const needs = task.needs?.map((need) =>
          typeof need === "string" || inThisWrite.has(need.key)
            ? need
            : (idOfKey.get(need.key) ?? need),
        );
        return [needs === undefined ? task : { ...task, needs }];
      });
      const key = options.idempotencyKey;
      const details = await this.createMany(channel, chunk, {
        idempotencyKey: key === undefined ? undefined : `${key}:${write}`,
      });
      places.forEach((place, at) => {
        const detail = details[at];
        const taskKey = tasks[place]?.key;
        created[place] = detail;
        if (detail && taskKey !== undefined) idOfKey.set(taskKey, detail.task.id);
      });
    }
    return created.filter((detail) => detail !== undefined);
  }

  /** Makes a task of a thread that already exists. Its text stays its author's; the task is yours. */
  async adopt(
    threadId: string,
    options: { needs?: string[] | undefined; for?: string | undefined } = {},
  ): Promise<TaskDetail> {
    const response = await this.request<CreateTasksResponse>("POST", "/tasks", {
      json: { thread: threadId, needs: options.needs, for: options.for },
    });
    const [task] = response.tasks;
    if (!task) throw new VibeError("task_not_found", "The task was not created.", 0);
    return task;
  }

  /**
   * Claims a task for a lease. Pass a task's ID to claim that one, which
   * throws when it can't be claimed. Pass a query to claim the oldest ready
   * task that matches, which returns `null` when none is ready in time.
   */
  async claim(
    target: string | ReadyQuery = {},
    options: ClaimOptions = {},
  ): Promise<TaskClaim | null> {
    if (typeof target === "string") {
      const body: ClaimTaskRequest = { id: target, lease: options.lease };
      return this.held(await this.send(body, options.signal));
    }

    const waitMs = target.wait === undefined ? 0 : waitOf(target.wait);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const remaining = Math.max(0, deadline - Date.now());
      const body: ClaimTaskRequest = {
        ready: target.channel ?? "",
        labels: labelFilters(target.label),
        from: target.from,
        wait: Math.min(MAX_WAIT_SECONDS, remaining / 1000),
        lease: options.lease,
      };
      const claimed = await this.send(body, options.signal);
      if (claimed) return this.held(claimed);
      if (remaining === 0) return null;
    }
  }

  async renew(id: string, claim: string, lease?: number): Promise<string> {
    const renewed = await this.request<RenewTaskResponse>("POST", this.at(id, "renew"), {
      json: { claim, lease },
    });
    return renewed.claim.expiresAt;
  }

  release(id: string, claim: string): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "release"), { json: { claim } });
  }

  complete(id: string, claim: string, result?: string): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "complete"), { json: { claim, result } });
  }

  fail(id: string, claim: string, reason: string): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "fail"), { json: { claim, reason } });
  }

  /**
   * Holds a task until a person answers. A worker passes its claim, which
   * ends. The task's owner needs none.
   */
  block(
    id: string,
    reason: string,
    options: { claim?: string | undefined; kind?: string | undefined } = {},
  ): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "block"), {
      json: { reason, claim: options.claim, kind: options.kind },
    });
  }

  /** Lifts a hold, as the task's owner. */
  unblock(id: string): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "unblock"));
  }

  /** Makes a failed task ready again, as its owner. */
  reopen(id: string): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "reopen"));
  }

  /** Keeps a task for one of its owner's profiles, or with `null` returns it to anyone who can claim it. */
  assign(id: string, profile: string | null): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "assign"), { json: { for: profile } });
  }

  /** Replaces the tasks a task waits for. An empty list makes it wait for nothing. */
  needs(id: string, needs: readonly string[]): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "needs"), { json: { needs } });
  }

  /** Calls a task off, as its owner. */
  cancel(id: string, reason: string): Promise<TaskDetail> {
    return this.request("POST", this.at(id, "cancel"), { json: { reason } });
  }

  private at(id: string, action: string): string {
    return `/tasks/${encodeURIComponent(id)}/${action}`;
  }

  private async send(body: ClaimTaskRequest, signal?: AbortSignal): Promise<ClaimedTask | null> {
    const response = await this.request<ClaimTaskResponse>("POST", "/tasks/claim", {
      json: body,
      signal,
    });
    return response.claimed;
  }

  private held(claimed: ClaimedTask | null): TaskClaim | null {
    if (!claimed) return null;
    const { id } = claimed.task;
    const claim = claimed.claim.id;
    return {
      ...claimed,
      renew: (lease) => this.renew(id, claim, lease),
      release: () => this.release(id, claim),
      complete: (result) => this.complete(id, claim, result),
      fail: (reason) => this.fail(id, claim, reason),
      block: (reason, options) => this.block(id, reason, { claim, kind: options?.kind }),
    };
  }
}

function labelFilters(label: Record<string, string> | string[] | undefined): string[] | undefined {
  if (label === undefined) return undefined;
  if (Array.isArray(label)) return label;
  return Object.entries(label).map(([key, value]) => `${key}=${value}`);
}

/** A wait as milliseconds: a number is seconds, a string is a duration such as `10m`. */
function waitOf(wait: number | string): number {
  return typeof wait === "number" ? parseDuration(wait * 1000) : parseDuration(wait);
}

/**
 * The places of a plan's tasks, each after the tasks it waits for by key.
 * Tasks that wait for each other are left in the order given; Vibe refuses them.
 */
function inDependencyOrder(tasks: readonly TaskInput[]): number[] {
  const placeOf = new Map<string, number>();
  tasks.forEach((task, place) => {
    if (task.key !== undefined) placeOf.set(task.key, place);
  });
  const order: number[] = [];
  const taken = new Set<number>();
  while (order.length < tasks.length) {
    const next: number[] = [];
    tasks.forEach((task, place) => {
      if (taken.has(place)) return;
      const waits = (task.needs ?? []).flatMap((need) =>
        typeof need === "string" ? [] : (placeOf.get(need.key) ?? []),
      );
      if (waits.every((needed) => taken.has(needed))) next.push(place);
    });
    if (next.length === 0) {
      tasks.forEach((_, place) => {
        if (!taken.has(place)) next.push(place);
      });
    }
    for (const place of next) {
      taken.add(place);
      order.push(place);
    }
  }
  return order;
}
