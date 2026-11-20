import { type ActorDirectory, type Authorizer, type Caller, parseProfile } from "@vibe/identity";
import {
  type BeginUnitOfWork,
  type Clock,
  conflict,
  type EventLog,
  newId,
  parseChannelPath,
} from "@vibe/kernel";
import {
  type Attachments,
  type IdempotencyStore,
  type Labels,
  messageDeleted,
  messageNotFound,
  Thread,
  type ThreadRepository,
  toRecords,
  type VibeRecord,
  type VisibleActors,
  writeConflict,
} from "@vibe/messaging";

import { invalidNeeds, invalidTask, taskExists } from "../domain/errors.ts";
import { orderPlan } from "../domain/plan.ts";
import { Task } from "../domain/task.ts";
import { noteOnThread } from "./changes.ts";
import type { TaskRepository } from "./ports.ts";
import type { TaskSweep } from "./sweep.ts";

export interface NewTask {
  /** Names this task for the others in the same write. */
  key?: string | undefined;
  text: string;
  labels?: Labels | undefined;
  /** Tasks to wait for: the ID of one that exists, or `{ key }` for one in this write. */
  needs?: readonly (string | { readonly key: string })[] | undefined;
  /** Keep the task for this profile of the creator's principal. */
  for?: string | undefined;
  attachments?: readonly string[] | undefined;
}

export interface CreateTasksCommand {
  caller: Caller;
  vibe: VibeRecord;
  channel: string;
  tasks: readonly NewTask[];
  /** Creates the tasks once, even when a retry sends the same key again. */
  idempotencyKey?: string | undefined;
}

export interface CreatedTasks {
  /** The new tasks' IDs, in the order the tasks were given. */
  ids: string[];
  /** `false` when the idempotency key matched an earlier write. */
  created: boolean;
  /** Mentions in the texts that settled on no one, and stayed plain text. */
  unresolved: string[];
}

export interface AdoptThreadCommand {
  caller: Caller;
  vibe: VibeRecord;
  /** Any message in the thread. */
  messageId: string;
  needs?: readonly string[] | undefined;
  for?: string | undefined;
}

const MAX_ATTEMPTS = 8;

/** Starts threads as tasks, one or a plan of several, and makes tasks of threads that exist. */
export class CreateTasks {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly threads: ThreadRepository,
    private readonly attachments: Attachments,
    private readonly idempotency: IdempotencyStore,
    private readonly visible: VisibleActors,
    private readonly eventLog: EventLog,
    private readonly authorizer: Authorizer,
    private readonly actors: ActorDirectory,
    private readonly sweep: TaskSweep,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Creates up to fifteen tasks in one commit: every thread, every task and
   * every event, or none of them. Tasks may wait for each other by key.
   */
  async execute(command: CreateTasksCommand): Promise<CreatedTasks> {
    const { tasks, threads, idempotency, eventLog, actors, begin, clock } = this;
    const { caller, vibe } = command;
    // Ordering the plan is what refuses keys that repeat, name nothing or lead in a circle.
    const steps = orderPlan(command.tasks);
    const given = [...steps].sort((a, b) => a.index - b.index);
    const channel = parseChannelPath(command.channel);
    const target = `${vibe.id}:tasks:${await digest({ channel, tasks: command.tasks })}`;

    const resource = { vibeId: vibe.id, channel };
    // A key belongs to the principal. A caller under a limit gets back only a
    // plan it could have made itself, not what its principal made elsewhere.
    if (caller.narrowed !== null) await this.authorizer.require(caller, "post", resource);
    const earlier = await this.replay(command, target);
    if (earlier) return earlier;

    await this.authorizer.require(caller, "post", resource);
    if (command.tasks.some((task) => Object.keys(task.labels ?? {}).length > 0)) {
      await this.authorizer.require(caller, "label", resource);
    }

    const files = command.tasks.flatMap((task) => task.attachments ?? []);
    if (new Set(files).size !== files.length) {
      throw invalidTask("Two tasks in the plan carry the same file.");
    }
    const existing = [...new Set(steps.flatMap((step) => step.needsExisting))];
    const settled = [];
    for (const task of command.tasks)
      settled.push(await this.visible.settle(caller, vibe, task.text));
    const assignees = command.tasks.map((task) =>
      task.for === undefined ? null : parseProfile(task.for),
    );

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const meanwhile = await this.replay(command, target);
        if (meanwhile) return meanwhile;
      }
      await this.attachments.assertPostable(caller, vibe, files);
      const completed = await this.completedAmong(caller, vibe, existing);

      const now = clock.now();
      const ids = command.tasks.map(() => newId("msg", now));
      const uow = begin();
      // Stored in the order given, which is the order a queue hands them out
      // in. Every ID exists already, so a task can go in before one it waits for.
      for (const step of given) {
        const input = command.tasks[step.index];
        const text = settled[step.index];
        const id = ids[step.index];
        if (!input || !text || id === undefined) continue;

        const thread = Thread.start({
          id,
          vibeId: vibe.id,
          channel,
          actorId: caller.actorId,
          text: text.text,
          attachmentIds: input.attachments,
          labels: input.labels,
          mentions: text.mentions,
          now,
        });
        const task = Task.create({
          id,
          vibeId: vibe.id,
          channel,
          owner: caller.actorId,
          assignee: assignees[step.index],
          needs: [...step.needsExisting, ...step.needsPlanned.flatMap((place) => ids[place] ?? [])],
          // A task of this same write can't have completed yet.
          unmet:
            step.needsPlanned.length > 0 || step.needsExisting.some((need) => !completed.has(need)),
          now,
        });
        noteOnThread(thread, task.pullEvents(), now);
        const events = thread.pullEvents();
        eventLog.append(uow, toRecords(thread, events));
        threads.save(uow, thread, events);
        tasks.save(uow, task);
        if (command.idempotencyKey !== undefined) {
          idempotency.record(uow, {
            principal: caller.principal,
            key: keyAt(command.idempotencyKey, step.index),
            target,
            messageId: id,
            createdAt: now,
          });
        }
      }
      actors.introduce(uow, caller, now);

      try {
        await uow.commit();
      } catch (error) {
        // Someone used the same key, or attached one of the files. The next
        // attempt sees it and either replays or fails with the reason.
        if (idempotency.isDuplicate(error) || threads.isAttachmentTaken(error)) continue;
        throw error;
      }
      // A prerequisite may have completed between the read above and the commit.
      if (existing.length > 0) await this.sweep.promoteQuietly({ among: ids });
      return { ids, created: true, unresolved: settled.flatMap((text) => text.unresolved) };
    }
    throw writeConflict();
  }

  /** Makes a task of a thread that already exists. Its text stays its author's; the task is the caller's. */
  async adopt(command: AdoptThreadCommand): Promise<string> {
    const { tasks, threads, eventLog, actors, authorizer, begin, clock } = this;
    const { caller, vibe, messageId } = command;
    const assignee = command.for === undefined ? null : parseProfile(command.for);
    const needs = [...new Set(command.needs ?? [])];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const thread = await threads.findByMessage(vibe.id, messageId);
      if (!thread) throw messageNotFound(messageId);
      const resource = { vibeId: vibe.id, channel: thread.snapshot.channel };
      const can = await authorizer.permissions(caller, resource);
      if (!can.has("read")) throw messageNotFound(messageId);
      if (!can.has("label")) await authorizer.require(caller, "label", resource);
      // A task's text is its instructions. A tombstone has none to give.
      if (thread.rootDeleted) throw messageDeleted(thread.id);
      if (await tasks.find(vibe.id, thread.id)) throw taskExists(thread.id);
      const completed = await this.completedAmong(caller, vibe, needs);

      const now = clock.now();
      const task = Task.create({
        id: thread.id,
        vibeId: vibe.id,
        channel: thread.snapshot.channel,
        owner: caller.actorId,
        assignee,
        needs,
        unmet: needs.some((need) => !completed.has(need)),
        now,
      });
      noteOnThread(thread, task.pullEvents(), now);
      const events = thread.pullEvents();
      const uow = begin();
      eventLog.append(uow, toRecords(thread, events));
      threads.save(uow, thread, events);
      tasks.save(uow, task);
      actors.introduce(uow, caller, now);
      try {
        await uow.commit();
      } catch (error) {
        if (tasks.isTaken(error)) throw taskExists(thread.id);
        if (eventLog.isVersionConflict(error)) continue;
        throw error;
      }
      if (needs.length > 0) await this.sweep.promoteQuietly({ among: [thread.id] });
      return thread.id;
    }
    throw writeConflict();
  }

  /** Returns the earlier tasks when this request repeats one, so a retry creates nothing. */
  private async replay(command: CreateTasksCommand, target: string): Promise<CreatedTasks | null> {
    const key = command.idempotencyKey;
    if (key === undefined) return null;
    const { principal } = command.caller;
    const first = await this.idempotency.find(principal, keyAt(key, 0));
    if (!first) return null;
    if (first.target !== target) {
      throw conflict(
        "duplicate_id",
        "This idempotency key was already used for other tasks.",
        "Use a new key for a new plan.",
      );
    }
    const ids = [first.messageId];
    for (let index = 1; index < command.tasks.length; index++) {
      const entry = await this.idempotency.find(principal, keyAt(key, index));
      if (entry) ids.push(entry.messageId);
    }
    return { ids, created: false, unresolved: [] };
  }

  /**
   * Checks that each prerequisite is a task the caller can read, and returns
   * the ones that have completed.
   */
  private async completedAmong(
    caller: Caller,
    vibe: VibeRecord,
    needs: readonly string[],
  ): Promise<Set<string>> {
    const completed = new Set<string>();
    if (needs.length === 0) return completed;
    const [states, scope] = await Promise.all([
      this.tasks.statesOf(vibe.id, needs),
      this.authorizer.scope(caller, vibe.id),
    ]);
    for (const need of needs) {
      const found = states.get(need);
      if (!found || !scope.allows(found.channel)) {
        throw invalidNeeds(`${need} is not a task you can read.`);
      }
      if (found.state === "completed") completed.add(need);
    }
    return completed;
  }
}

/** Where one task of a keyed write is remembered. */
function keyAt(key: string, index: number): string {
  return `${key}#${index}`;
}

/** A short fingerprint of what a key was used for, to refuse its reuse for something else. */
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
