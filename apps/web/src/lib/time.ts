const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago something happened, short enough for a strip: `now`, `5m`, `3h`, `2d`, then a date. */
export function ago(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  const passed = Math.max(0, now - then);
  if (passed < MINUTE) return "now";
  if (passed < HOUR) return `${Math.floor(passed / MINUTE)}m`;
  if (passed < DAY) return `${Math.floor(passed / HOUR)}h`;
  if (passed < 7 * DAY) return `${Math.floor(passed / DAY)}d`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** A time in full, for a tooltip and for whoever wants the exact moment. */
export function exact(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** How long is left until a time, such as a lease's end: `2m 10s`, or `null` once it has passed. */
export function remaining(iso: string, now: number = Date.now()): string | null {
  const left = Date.parse(iso) - now;
  if (left <= 0) return null;
  const seconds = Math.ceil(left / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * A CSS time, such as a duration token read back from the page, in
 * milliseconds. A build may write `200ms` as `.2s`.
 */
export function milliseconds(time: string, otherwise: number): number {
  const amount = Number.parseFloat(time);
  if (Number.isNaN(amount)) return otherwise;
  return time.trim().endsWith("ms") ? amount : amount * 1000;
}
