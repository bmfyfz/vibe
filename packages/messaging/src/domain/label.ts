import { isLabelKey } from "@vibe/kernel";

import { invalidLabel, labelConflict, reservedLabel } from "./errors.ts";

/** A message's labels: one value per key. */
export type Labels = Readonly<Record<string, string>>;

export const MAX_LABELS = 64;
export const MAX_LABEL_VALUE_BYTES = 256;
/** Labels under this prefix record state the vibe keeps, such as a task's. Nobody sets them by hand. */
export const RESERVED_LABEL_PREFIX = "vibe.";

export interface LabelChange {
  /** Labels to set. Setting a key again replaces its value. */
  readonly set?: Readonly<Record<string, string>> | undefined;
  /** Keys to remove. */
  readonly unset?: readonly string[] | undefined;
  /**
   * What the labels must be for the change to happen: a value, or `null` for a
   * key that mustn't be set. The check and the change are one write.
   */
  readonly if?: Readonly<Record<string, string | null>> | undefined;
}

export interface AppliedLabelChange {
  readonly labels: Labels;
  /** What the change really set and removed. Both empty when the labels already were as asked. */
  readonly set: Labels;
  readonly unset: readonly string[];
}

const CONTROL = /\p{Cc}/u;

/** Checks labels someone means to set: their keys, their values, and that none is the vibe's own. */
export function assertSettable(labels: Readonly<Record<string, string>>): void {
  // A message is held to the same number however it came by its labels: one
  // posted with more than it may hold could never have a label changed again.
  assertCount(labels);
  for (const [key, value] of Object.entries(labels)) {
    assertKey(key);
    if (key.startsWith(RESERVED_LABEL_PREFIX)) throw reservedLabel(key);
    if (value === "") {
      throw invalidLabel(`The label ${key} needs a value.`, "To remove a label, unset it.");
    }
    if (new TextEncoder().encode(value).length > MAX_LABEL_VALUE_BYTES || CONTROL.test(value)) {
      throw invalidLabel(
        `The value of ${key} must be at most ${MAX_LABEL_VALUE_BYTES} bytes, with no control characters.`,
        "Keep longer detail in the thread.",
      );
    }
  }
}

/**
 * Works out what a change does to a message's labels. Fails with
 * `label_conflict` when a condition doesn't hold, and changes nothing then.
 */
export function applyLabelChange(current: Labels, change: LabelChange): AppliedLabelChange {
  const toSet = change.set ?? {};
  const toUnset = change.unset ?? [];
  assertSettable(toSet);
  for (const key of toUnset) {
    assertKey(key);
    if (key.startsWith(RESERVED_LABEL_PREFIX)) throw reservedLabel(key);
    if (Object.hasOwn(toSet, key)) {
      throw invalidLabel(`The label ${key} can't be both set and unset.`);
    }
  }

  for (const [key, expected] of Object.entries(change.if ?? {})) {
    assertKey(key);
    // The error names the label and never its value: holding `label` in a
    // channel doesn't mean you can read what's there.
    if (labelValue(current, key) !== expected) throw labelConflict(key);
  }

  const labels: Record<string, string> = { ...current };
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(toSet)) {
    if (labelValue(labels, key) === value) continue;
    labels[key] = value;
    set[key] = value;
  }
  for (const key of toUnset) {
    if (!Object.hasOwn(labels, key)) continue;
    delete labels[key];
    unset.push(key);
  }
  assertCount(labels);
  return { labels, set, unset };
}

/**
 * The value a message holds under a key, or `null` when it holds none. A key
 * is whatever its writer chose, `constructor` and `toString` included, and
 * those must not find what every object has under such a name.
 */
export function labelValue(labels: Labels, key: string): string | null {
  return Object.hasOwn(labels, key) ? (labels[key] ?? null) : null;
}

function assertCount(labels: Labels): void {
  if (Object.keys(labels).length > MAX_LABELS) {
    throw invalidLabel(`A message holds up to ${MAX_LABELS} labels.`);
  }
}

function assertKey(key: string): void {
  if (isLabelKey(key)) return;
  throw invalidLabel(
    `"${key}" is not a label key.`,
    "Use up to 64 lowercase letters, numbers, _, . and -, starting with a letter or a number.",
  );
}
