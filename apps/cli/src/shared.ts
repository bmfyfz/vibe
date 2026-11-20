/** The command was called wrongly. Exits with 2, apart from every other failure. */
export class UsageError extends Error {}

export function integer(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`${flag} takes a whole number, not "${value}".`);
  }
  return parsed;
}

/** The text of a command: from a file, from stdin when either names `-`, or as typed. */
export async function readText(file: string | undefined, inline: string): Promise<string> {
  if (file === "-" || inline === "-") return (await Bun.stdin.text()).trimEnd();
  if (file !== undefined) return (await Bun.file(file).text()).trimEnd();
  return inline;
}
