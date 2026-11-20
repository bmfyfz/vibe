import type { Message } from "@vibe/sdk";

/** The colours a strip's first box comes in: what stage the work is at. */
export type Holder = "ready" | "claimed" | "blocked" | "done" | "waiting" | "ended";

/** The label a task's state is kept in on its root. */
const TASK_LABEL = "vibe.task";

// What agents and synced platforms write in `state`, by the stage it means.
const BY_WORD: Record<string, Holder> = {
  ready: "ready",
  open: "ready",
  unstarted: "ready",
  todo: "ready",
  claimed: "claimed",
  started: "claimed",
  fixing: "claimed",
  "in-progress": "claimed",
  doing: "claimed",
  blocked: "blocked",
  changes_requested: "blocked",
  completed: "done",
  merged: "done",
  done: "done",
  fixed: "done",
  approved: "done",
  waiting: "waiting",
  draft: "waiting",
  backlog: "waiting",
  triage: "waiting",
  failed: "ended",
  canceled: "ended",
  closed: "ended",
};

/**
 * What a thread's first box says: its task's state when it is a task, and
 * otherwise what its root's `state` label says, which is where agents and
 * synced platforms keep a thread's stage. `null` for a thread with neither.
 */
export function stateOf(
  root: Pick<Message, "labels">,
): { word: string; holder: Holder; task: boolean } | null {
  const task = root.labels[TASK_LABEL];
  const word = task ?? root.labels["state"];
  if (word === undefined) return null;
  return { word, holder: BY_WORD[word.toLowerCase()] ?? "waiting", task: task !== undefined };
}

/** The labels a strip shows as labels: all but the ones its first box already says. */
export function shownLabels(message: Pick<Message, "labels">): [string, string][] {
  const state = stateOf(message);
  return Object.entries(message.labels).filter(
    ([key]) => key !== TASK_LABEL && !(key === "state" && state !== null && !state.task),
  );
}
