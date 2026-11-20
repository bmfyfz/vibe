import { invalid } from "@vibe/kernel";

const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

/** The name you type to mention someone or filter by them, such as `ada`. */
export function parseHandle(input: string): string {
  const handle = input.toLowerCase();
  if (!HANDLE.test(handle)) {
    throw invalid(
      "invalid_handle",
      `"${input}" is not a handle.`,
      "Use up to 39 letters, numbers and hyphens, starting and ending with a letter or number.",
    );
  }
  return handle;
}
