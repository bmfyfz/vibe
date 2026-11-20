import { invalid } from "@vibe/kernel";

const CURSOR = /^cur_([0-9a-z]{1,11})$/;

/**
 * A cursor marks a place in a vibe's event log. Clients pass it back exactly as
 * they got it; what's inside is ours to change.
 */
export function encodeCursor(seq: number): string {
  return `cur_${seq.toString(36)}`;
}

export function decodeCursor(cursor: string): number {
  const match = CURSOR.exec(cursor);
  const seq = match?.[1] ? Number.parseInt(match[1], 36) : Number.NaN;
  if (!Number.isSafeInteger(seq)) {
    throw invalid(
      "invalid_cursor",
      `"${cursor}" is not a cursor.`,
      "Pass a cursor or a message ID exactly as Vibe returned it.",
    );
  }
  return seq;
}

/** A message ID is a cursor too: it marks the event that posted the message. */
export function isMessageId(value: string): boolean {
  return value.startsWith("msg_");
}
