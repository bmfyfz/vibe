import { ConstraintViolation, principalOf, type UnitOfWork } from "@vibe/kernel";
import {
  and,
  asc,
  channelMatches,
  type Db,
  enlist,
  eq,
  inArray,
  isNull,
  lte,
  or,
  schema,
  type SQL,
  sql,
} from "@vibe/store";

import type { ClaimableQuery, TaskPlace, TaskRepository } from "../application/ports.ts";
import { Task, type TaskState } from "../domain/task.ts";

const { messageLabels, taskNeeds, tasks } = schema;

/**
 * The order tasks were stored in. Two tasks can be created in the same
 * millisecond, and their IDs are random past the time, so neither settles which
 * is older. SQLite numbers rows as they are inserted, and D1 has one writer, so
 * this is the order their commits landed in.
 */
export const STORED_ORDER = sql<number>`${tasks}.rowid`;

/** A needed task that hasn't completed, or that isn't there at all. */
const UNMET = sql`(needed.state IS NULL OR needed.state <> 'completed')`;

// D1 takes at most 100 bound parameters in a statement.
const IDS_PER_STATEMENT = 90;

export class DrizzleTaskRepository implements TaskRepository {
  constructor(private readonly db: Db) {}

  async find(vibeId: string, id: string): Promise<Task | null> {
    const row = await this.db
      .select({
        task: tasks,
        needs: sql<string>`(
          SELECT json_group_array(need.needs_id) FROM task_needs need
          WHERE need.task_id = ${tasks.id})`,
      })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.vibeId, vibeId)))
      .get();
    if (!row) return null;

    const { task } = row;
    const held = task.claimId !== null && task.claimedBy !== null && task.leaseExpiresAt !== null;
    return Task.rehydrate({
      id: task.id,
      vibeId: task.vibeId,
      channel: task.channel,
      owner: task.owner,
      state: task.state,
      assignee: task.assignee,
      claim: held
        ? { id: task.claimId ?? "", by: task.claimedBy ?? "", expiresAt: task.leaseExpiresAt ?? 0 }
        : null,
      hold: task.holdKind === null ? null : { kind: task.holdKind, reason: task.holdReason ?? "" },
      needs: JSON.parse(row.needs) as string[],
      result: task.result,
      reason: task.reason,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
  }

  save(uow: UnitOfWork, task: Task): void {
    const work = enlist(uow);
    const state = task.snapshot;
    const changing = {
      state: state.state,
      assignee: state.assignee,
      claimId: state.claim?.id ?? null,
      claimedBy: state.claim?.by ?? null,
      leaseExpiresAt: state.claim?.expiresAt ?? null,
      holdKind: state.hold?.kind ?? null,
      holdReason: state.hold?.reason ?? null,
      result: state.result,
      reason: state.reason,
      updatedAt: state.updatedAt,
    };

    if (task.isNew) {
      work.add(
        this.db.insert(tasks).values({
          id: state.id,
          vibeId: state.vibeId,
          channel: state.channel,
          owner: state.owner,
          ownerPrincipal: principalOf(state.owner),
          createdAt: state.createdAt,
          ...changing,
        }),
      );
    } else {
      work.add(this.db.update(tasks).set(changing).where(eq(tasks.id, state.id)));
    }

    if (!task.needsDirty) return;
    if (!task.isNew) work.add(this.db.delete(taskNeeds).where(eq(taskNeeds.taskId, state.id)));
    const [first] = state.needs;
    if (first === undefined) return;
    work.add(
      this.db
        .insert(taskNeeds)
        .values(state.needs.map((needsId) => ({ taskId: state.id, needsId }))),
    );
    // Whether tasks wait in a circle was checked before this commit, from
    // what was stored then. Another task's needs may have changed since, and
    // that change is guarded by its own thread, not this one. So it is
    // checked once more here, inside the commit, against what is stored
    // now: when this task has come to wait for itself, the statement below
    // writes a row that is already there, and the whole commit fails.
    work.add(
      this.db.run(sql`
        INSERT INTO task_needs (task_id, needs_id)
        SELECT ${state.id}, ${first} WHERE EXISTS (
          WITH RECURSIVE upstream(id) AS (
            SELECT needs_id FROM task_needs WHERE task_id = ${state.id}
            UNION
            SELECT need.needs_id FROM task_needs need JOIN upstream ON need.task_id = upstream.id
          )
          SELECT 1 FROM upstream WHERE id = ${state.id})`),
    );
  }

  isTaken(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("tasks");
  }

  closedCircle(error: unknown): boolean {
    return error instanceof ConstraintViolation && error.on("task_needs");
  }

  async statesOf(
    vibeId: string,
    ids: readonly string[],
  ): Promise<Map<string, { state: TaskState; channel: string }>> {
    const found = new Map<string, { state: TaskState; channel: string }>();
    // A plan of fifteen tasks may name three hundred others, and D1 takes a
    // hundred bound parameters in a statement.
    const wanted = [...new Set(ids)];
    for (let from = 0; from < wanted.length; from += IDS_PER_STATEMENT) {
      const rows = await this.db
        .select({ id: tasks.id, state: tasks.state, channel: tasks.channel })
        .from(tasks)
        .where(
          and(
            eq(tasks.vibeId, vibeId),
            inArray(tasks.id, wanted.slice(from, from + IDS_PER_STATEMENT)),
          ),
        );
      for (const row of rows) found.set(row.id, { state: row.state, channel: row.channel });
    }
    return found;
  }

  async hasUnmet(id: string): Promise<boolean> {
    const rows = await this.db.values<[number]>(sql`
      SELECT 1 FROM task_needs need
      LEFT JOIN tasks needed ON needed.id = need.needs_id
      WHERE need.task_id = ${id} AND ${UNMET}
      LIMIT 1`);
    return rows.length > 0;
  }

  async reaches(from: readonly string[], target: string): Promise<boolean> {
    if (from.length === 0) return false;
    if (from.includes(target)) return true;
    const start = sql.join(
      from.map((id) => sql`${id}`),
      sql`, `,
    );
    const rows = await this.db.values<[number]>(sql`
      WITH RECURSIVE upstream(id) AS (
        SELECT needs_id FROM task_needs WHERE task_id IN (${start})
        UNION
        SELECT need.needs_id FROM task_needs need JOIN upstream ON need.task_id = upstream.id
      )
      SELECT 1 FROM upstream WHERE id = ${target} LIMIT 1`);
    return rows.length > 0;
  }

  promotable(
    where: { needing?: string; among?: readonly string[] },
    limit: number,
  ): Promise<TaskPlace[]> {
    if (where.among?.length === 0) return Promise.resolve([]);
    return this.db
      .select({ id: tasks.id, vibeId: tasks.vibeId, channel: tasks.channel })
      .from(tasks)
      .where(
        and(
          eq(tasks.state, "waiting"),
          where.among === undefined ? undefined : inArray(tasks.id, [...where.among]),
          where.needing === undefined
            ? undefined
            : sql`EXISTS (
                SELECT 1 FROM task_needs need
                WHERE need.task_id = ${tasks.id} AND need.needs_id = ${where.needing})`,
          sql`NOT EXISTS (
            SELECT 1 FROM task_needs need
            LEFT JOIN tasks needed ON needed.id = need.needs_id
            WHERE need.task_id = ${tasks.id} AND ${UNMET})`,
        ),
      )
      .orderBy(asc(tasks.createdAt), asc(STORED_ORDER))
      .limit(limit);
  }

  expired(now: number, limit: number): Promise<TaskPlace[]> {
    return this.db
      .select({ id: tasks.id, vibeId: tasks.vibeId, channel: tasks.channel })
      .from(tasks)
      .where(and(eq(tasks.state, "claimed"), lte(tasks.leaseExpiresAt, now)))
      .orderBy(asc(tasks.leaseExpiresAt))
      .limit(limit);
  }

  claimable(query: ClaimableQuery): Promise<TaskPlace[]> {
    const mine = eq(tasks.ownerPrincipal, query.principal);
    const pooled = and(
      isNull(tasks.assignee),
      query.from.length > 0 ? or(mine, inArray(tasks.owner, [...query.from])) : mine,
    );
    const keptForMe =
      query.profile === null ? undefined : and(eq(tasks.assignee, query.profile), mine);

    const labelled: SQL[] = query.labels.map(
      (label) => sql`EXISTS (
        SELECT 1 FROM ${messageLabels}
        WHERE ${and(
          eq(messageLabels.messageId, tasks.id),
          eq(messageLabels.key, label.key),
          label.values === null ? undefined : inArray(messageLabels.value, [...label.values]),
        )})`,
    );

    return this.db
      .select({ id: tasks.id, vibeId: tasks.vibeId, channel: tasks.channel })
      .from(tasks)
      .where(
        and(
          eq(tasks.vibeId, query.vibeId),
          channelMatches(tasks.channel, query.channel),
          // A claim whose lease has run out no longer holds its task.
          or(
            eq(tasks.state, "ready"),
            and(eq(tasks.state, "claimed"), lte(tasks.leaseExpiresAt, query.now)),
          ),
          or(pooled, keptForMe),
          ...labelled,
        ),
      )
      .orderBy(sql`${tasks.assignee} IS NULL`, asc(tasks.createdAt), asc(STORED_ORDER))
      .limit(query.limit)
      .offset(query.offset);
  }
}
