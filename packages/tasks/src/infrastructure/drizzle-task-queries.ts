import type { Task as TaskView, TaskDetail } from "@vibe/contracts";
import type { ChannelScope } from "@vibe/kernel";
import { actorFields, messageFields, toActor, toMessage, wroteAs } from "@vibe/messaging";
import {
  alias,
  and,
  asc,
  channelMatches,
  type Db,
  eq,
  gt,
  inArray,
  lte,
  or,
  schema,
  type SQL,
  sql,
} from "@vibe/store";

import type { TaskFilter, TaskQueries } from "../application/ports.ts";
import type { TaskState } from "../domain/task.ts";
import { STORED_ORDER } from "./drizzle-task-repository.ts";

const { actors, messageLabels, messages, tasks, threads } = schema;

const PAGE = 50;

export class DrizzleTaskQueries implements TaskQueries {
  constructor(private readonly db: Db) {}

  async get(vibeId: string, id: string, now: number): Promise<TaskDetail | null> {
    const [found] = await this.select(and(eq(tasks.vibeId, vibeId), eq(tasks.id, id)), now, 1);
    return found?.detail ?? null;
  }

  async getMany(vibeId: string, ids: readonly string[], now: number): Promise<TaskDetail[]> {
    if (ids.length === 0) return [];
    const rows = await this.select(
      and(eq(tasks.vibeId, vibeId), inArray(tasks.id, [...ids])),
      now,
      ids.length,
    );
    const byId = new Map(rows.map((row) => [row.detail.task.id, row.detail]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  /**
   * Oldest first, which is the order a queue works them in. Like thread lists,
   * access is decided in the domain: pages are filtered here, and more are
   * read until enough tasks are left or none remain.
   */
  async list(
    vibeId: string,
    filter: TaskFilter,
    scope: ChannelScope,
    now: number,
  ): Promise<TaskDetail[]> {
    const owner = alias(actors, "owner");
    const conditions = [
      eq(tasks.vibeId, vibeId),
      channelMatches(tasks.channel, filter.channel),
      filter.states === null ? undefined : or(...filter.states.map((state) => inState(state, now))),
      filter.for === undefined ? undefined : eq(tasks.assignee, filter.for),
      filter.by === undefined
        ? undefined
        : sql`EXISTS (
            SELECT 1 FROM ${actors} ${sql.raw('"owner"')}
            WHERE ${and(eq(owner.id, tasks.owner), wroteAs(owner, filter.by))})`,
      ...(filter.labels ?? []).map(
        (label): SQL => sql`EXISTS (
          SELECT 1 FROM ${messageLabels}
          WHERE ${and(
            eq(messageLabels.messageId, tasks.id),
            eq(messageLabels.key, label.key),
            label.values === null ? undefined : inArray(messageLabels.value, [...label.values]),
          )})`,
      ),
    ];

    const visible: TaskDetail[] = [];
    const size = scope.all ? filter.limit : Math.max(filter.limit, PAGE);
    let after: { createdAt: number; stored: number } | undefined;
    for (;;) {
      const page = await this.select(
        and(
          ...conditions,
          after === undefined
            ? undefined
            : or(
                gt(tasks.createdAt, after.createdAt),
                and(eq(tasks.createdAt, after.createdAt), gt(STORED_ORDER, after.stored)),
              ),
        ),
        now,
        size,
      );
      for (const row of page) {
        if (scope.allows(row.detail.task.channel)) visible.push(row.detail);
        if (visible.length === filter.limit) return visible;
      }
      const last = page[page.length - 1];
      if (page.length < size || !last) return visible;
      after = { createdAt: last.createdAt, stored: last.stored };
    }
  }

  private async select(
    where: SQL | undefined,
    now: number,
    limit: number,
  ): Promise<{ detail: TaskDetail; createdAt: number; stored: number }[]> {
    const owner = alias(actors, "task_owner");
    const holder = alias(actors, "task_holder");
    const author = alias(actors, "root_author");

    const rows = await this.db
      .select({
        task: tasks,
        stored: STORED_ORDER,
        needs: sql<string>`(
          SELECT json_group_array(need.needs_id) FROM task_needs need
          WHERE need.task_id = ${tasks.id})`,
        owner: actorFields(owner),
        holder: actorFields(holder),
        root: messageFields({ message: messages, author, thread: threads }),
      })
      .from(tasks)
      .innerJoin(threads, eq(threads.id, tasks.id))
      .innerJoin(messages, eq(messages.id, tasks.id))
      .innerJoin(author, eq(author.id, messages.actorId))
      .innerJoin(owner, eq(owner.id, tasks.owner))
      .leftJoin(holder, eq(holder.id, tasks.claimedBy))
      .where(where)
      .orderBy(asc(tasks.createdAt), asc(STORED_ORDER))
      .limit(limit);

    const found: { detail: TaskDetail; createdAt: number; stored: number }[] = [];
    for (const row of rows) {
      const message = toMessage(row.root);
      if (!message) continue;
      const { task } = row;
      // A lease that has run out no longer holds the task, whether or not the
      // sweep has recorded that yet.
      const held =
        task.state === "claimed" && task.leaseExpiresAt !== null && task.leaseExpiresAt > now;
      const view: TaskView = {
        id: task.id,
        channel: task.channel,
        state: task.state === "claimed" && !held ? "ready" : task.state,
        owner: toActor(row.owner),
        for: task.assignee,
        claimedBy: held && row.holder.actor !== null ? toActor(row.holder) : null,
        leaseExpiresAt: held ? iso(task.leaseExpiresAt ?? now) : null,
        needs: JSON.parse(row.needs) as string[],
        hold:
          task.state === "blocked" && task.holdKind !== null
            ? { kind: task.holdKind, reason: task.holdReason ?? "" }
            : null,
        result: task.result,
        reason: task.reason,
        createdAt: iso(task.createdAt),
        updatedAt: iso(task.updatedAt),
      };
      found.push({
        detail: { task: view, message },
        createdAt: task.createdAt,
        stored: row.stored,
      });
    }
    return found;
  }
}

/** The condition that a task is, in effect, in a state. */
function inState(state: TaskState, now: number): SQL | undefined {
  if (state === "ready") {
    return or(
      eq(tasks.state, "ready"),
      and(eq(tasks.state, "claimed"), lte(tasks.leaseExpiresAt, now)),
    );
  }
  if (state === "claimed") return and(eq(tasks.state, "claimed"), gt(tasks.leaseExpiresAt, now));
  return eq(tasks.state, state);
}

function iso(time: number): string {
  return new Date(time).toISOString();
}
