import { invalid } from "./errors.ts";

const KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** A label's key: lowercase letters, numbers, `_`, `.` and `-`, up to 64, starting with a letter or number. */
export function isLabelKey(key: string): boolean {
  return KEY.test(key);
}

/** One `--label` filter: a key, with any value or with one of several. */
export interface LabelFilter {
  readonly key: string;
  /** The values that match, or `null` when any value does. */
  readonly values: readonly string[] | null;
}

// A filter's values and the filters of one query become bound parameters, and
// D1 takes at most 100 in a statement.
export const MAX_LABEL_FILTERS = 4;
export const MAX_LABEL_FILTER_VALUES = 8;

/** Reads `status`, `status=open` or `status=open|draft`. */
export function parseLabelFilter(input: string): LabelFilter {
  const equals = input.indexOf("=");
  const key = equals === -1 ? input : input.slice(0, equals);
  const values = equals === -1 ? null : input.slice(equals + 1).split("|");
  if (!isLabelKey(key) || (values !== null && values.length > MAX_LABEL_FILTER_VALUES)) {
    throw invalid(
      "invalid_label",
      `"${input}" is not a label filter.`,
      `Use a key, key=value, or up to ${MAX_LABEL_FILTER_VALUES} values as key=value|other, such as state=open|draft.`,
    );
  }
  return { key, values };
}

/** Reads the `label` filters of one query. Every one must match. */
export function parseLabelFilters(inputs: readonly string[]): LabelFilter[] {
  if (inputs.length > MAX_LABEL_FILTERS) {
    throw invalid(
      "invalid_label",
      `A query takes up to ${MAX_LABEL_FILTERS} label filters.`,
      "Narrow further once you have the results.",
    );
  }
  return inputs.map(parseLabelFilter);
}
