import { invalidNeeds, invalidTask } from "./errors.ts";

/** The most tasks one write creates. A longer plan takes several writes. */
export const MAX_TASKS_PER_WRITE = 15;

/** A task as a plan describes it, before it has an ID. */
export interface PlannedTask {
  /** Names the task for the others in the same plan. */
  readonly key?: string | undefined;
  /** What it waits for: the ID of a task that exists, or the key of one in this plan. */
  readonly needs?: readonly (string | { readonly key: string })[] | undefined;
}

export interface PlanStep {
  /** The task's place in the plan as it was given. */
  readonly index: number;
  /** Tasks that exist already, by ID. */
  readonly needsExisting: readonly string[];
  /** Tasks of this plan, by their place in it. */
  readonly needsPlanned: readonly number[];
}

/**
 * Works out the order to create a plan's tasks in: each one after the tasks it
 * waits for. Refuses a plan whose keys repeat, name nothing, or lead in a circle.
 */
export function orderPlan(tasks: readonly PlannedTask[]): PlanStep[] {
  if (tasks.length === 0) throw invalidTask("A plan needs at least one task.");
  if (tasks.length > MAX_TASKS_PER_WRITE) {
    throw invalidTask(
      `One write creates up to ${MAX_TASKS_PER_WRITE} tasks.`,
      "Create a longer plan in several writes, each task after the tasks it waits for.",
    );
  }

  const placeOf = new Map<string, number>();
  tasks.forEach((task, index) => {
    if (task.key === undefined) return;
    if (placeOf.has(task.key)) throw invalidTask(`Two tasks in the plan have the key ${task.key}.`);
    placeOf.set(task.key, index);
  });

  const steps = tasks.map((task, index): PlanStep => {
    const needsExisting: string[] = [];
    const needsPlanned: number[] = [];
    for (const need of task.needs ?? []) {
      if (typeof need === "string") {
        if (!needsExisting.includes(need)) needsExisting.push(need);
        continue;
      }
      const place = placeOf.get(need.key);
      if (place === undefined) throw invalidNeeds(`No task in the plan has the key ${need.key}.`);
      if (place === index) throw invalidNeeds("A task can't wait for itself.");
      if (!needsPlanned.includes(place)) needsPlanned.push(place);
    }
    return { index, needsExisting, needsPlanned };
  });

  // Take, again and again, every task whose prerequisites are already taken.
  const ordered: PlanStep[] = [];
  const taken = new Set<number>();
  while (ordered.length < steps.length) {
    const next = steps.filter(
      (step) => !taken.has(step.index) && step.needsPlanned.every((place) => taken.has(place)),
    );
    if (next.length === 0) throw invalidNeeds("Tasks in the plan wait for each other.");
    for (const step of next) {
      taken.add(step.index);
      ordered.push(step);
    }
  }
  return ordered;
}
