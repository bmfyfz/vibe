import { invalid } from "@vibe/kernel";

/** The vibe every team has, and the one used when none is named. */
export const DEFAULT_VIBE = "general";

/** A vibe's name is 1 to 64 characters with no `/`, and matches regardless of case. */
export function parseVibeName(input: string): string {
  const name = input.trim().toLowerCase();
  if (name.length < 1 || name.length > 64 || name.includes("/")) {
    throw invalid(
      "invalid_vibe_name",
      `"${input}" is not a vibe name.`,
      "Use 1 to 64 characters, with no /.",
    );
  }
  return name;
}
