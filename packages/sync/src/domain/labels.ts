import { isLabelKey } from "@vibe/kernel";

const MAX_VALUE_BYTES = 256;

/**
 * A platform's name as part of a label key: lowercase letters, numbers, `_`,
 * `.` and `-`. `good first issue` becomes `good-first-issue`.
 */
function keyPart(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** A value a label can hold: no control characters, not empty, and short enough. */
function value(text: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (clean === "") return null;
  let out = clean;
  while (new TextEncoder().encode(out).length > MAX_VALUE_BYTES) out = out.slice(0, -1);
  return out;
}

/**
 * Collects the labels a platform's state arrives as. A key the vibe couldn't
 * hold, or a value it couldn't, is left out: a platform's label never makes a
 * thread fail to come in.
 */
export class PlatformLabels {
  private readonly labels: Record<string, string> = {};

  /** Sets `key=value`, such as `state=open`. */
  set(key: string, text: string | null | undefined): this {
    const held = text === null || text === undefined ? null : value(text);
    if (held !== null && isLabelKey(key) && !key.startsWith("vibe.")) this.labels[key] = held;
    return this;
  }

  /** Sets one label under a prefix for a name, such as `tag.bug=bug` or `assignee.ada=ada`. */
  each(prefix: "tag" | "assignee", names: readonly (string | null | undefined)[]): this {
    for (const name of names) {
      if (name === null || name === undefined) continue;
      const part = keyPart(name).slice(0, 64 - prefix.length - 1);
      if (part !== "") this.set(`${prefix}.${part}`, name);
    }
    return this;
  }

  get all(): Record<string, string> {
    return { ...this.labels };
  }
}

/**
 * What to do to a root's labels so that the ones a platform owns say what the
 * platform says now, and the rest stay as people set them.
 *
 * @param owned The keys, and the key prefixes ending in `.`, that the platform
 *   decides: any of them the platform no longer gives is removed.
 */
export function platformLabelChange(
  current: Readonly<Record<string, string>>,
  wanted: Readonly<Record<string, string>>,
  owned: readonly string[],
): { set: Record<string, string>; unset: string[] } {
  const set: Record<string, string> = {};
  for (const [key, held] of Object.entries(wanted)) {
    if (current[key] !== held) set[key] = held;
  }
  const mine = (key: string) =>
    owned.some((own) => (own.endsWith(".") ? key.startsWith(own) : key === own));
  const unset = Object.keys(current).filter((key) => mine(key) && !(key in wanted));
  return { set, unset };
}
