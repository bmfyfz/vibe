import { newSecret } from "@vibe/kernel";

/**
 * How long a person stays signed in from a browser. It is counted from when
 * they signed in, and using the session doesn't extend it.
 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PREFIX = "vibe_ses";

/** The secret a browser holds in its cookie. Only its hash is stored. */
export function generateSessionSecret(): string {
  return newSecret(PREFIX);
}

/** Whether something could be a session's secret. Anything else is not looked up at all. */
export function isSessionSecret(value: string): boolean {
  return value.startsWith(`${PREFIX}_`) && value.length <= 100;
}

const MAX_BROWSER_NAME_LENGTH = 200;

/**
 * What a browser called itself, as it is kept to tell sessions apart: one
 * line of printable text, cut short. It is whatever the request said, so it
 * is shown as text and trusted for nothing.
 */
export function browserName(userAgent: string | null | undefined): string | null {
  const text = (userAgent ?? "")
    // Control characters, and the characters that reorder or hide text.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : text.slice(0, MAX_BROWSER_NAME_LENGTH);
}
