import { principalOf } from "@vibe/kernel";

import { assertBlocks, type Block } from "./block.ts";
import { invalidMessage } from "./errors.ts";
import type { Labels } from "./label.ts";
import { writtenLength } from "./mentions.ts";

export const MAX_TEXT_LENGTH = 10_000;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Markdown that one actor wrote, at one place in one thread. */
export interface Message {
  readonly id: string;
  readonly threadId: string;
  /** The exact message answered, when that isn't the thread's root. */
  readonly replyTo: string | null;
  readonly actorId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  /** Its structured data, each block already checked against its schema. */
  readonly blocks: readonly Block[];
  readonly labels: Labels;
  /** The actors its text mentions, as `@[actor-id]`. */
  readonly mentions: readonly string[];
  /** Its place in the thread: the thread's version when it was posted. */
  readonly position: number;
  /** The key of the sync entry it came in through, or `null` when it was written on the vibe. */
  readonly source: string | null;
  /** Kept off every synced platform. On a thread's root, the whole thread is. */
  readonly noSync: boolean;
  readonly createdAt: number;
}

/** What a thread remembers of a message it has loaded: enough to decide a change to it. */
export interface MessageState {
  readonly id: string;
  readonly actorId: string;
  readonly text: string;
  /** Changes with each edit, and with the delete. */
  readonly revision: number;
  /** Set once the message is a tombstone. */
  readonly deletedAt: number | null;
  /** The sync entry it came in through, by its key. `null` when it was written here. */
  readonly source: string | null;
  readonly attachmentCount: number;
  readonly blocks: readonly Block[];
  readonly labels: Labels;
  readonly mentions: readonly string[];
  readonly reactions: readonly Reaction[];
}

export interface Reaction {
  /** The emoji's normalized name, such as `eyes`. */
  readonly emoji: string;
  readonly actorId: string;
}

/** Who asks to edit or delete: an actor, and the principal it writes for. */
export interface Editor {
  readonly actorId: string;
  readonly principal: string;
  readonly profile: string | null;
}

/**
 * Whether an editor may change a message. A profile changes only what it
 * wrote. A principal writing as itself changes what any of its profiles wrote,
 * so a person can fix their agents' messages.
 */
export function wrote(message: Pick<MessageState, "actorId" | "source">, editor: Editor): boolean {
  if (message.actorId === editor.actorId) return true;
  // What came in from a platform is its writer's there. The service it came
  // in through holds the pen, not the words: its token changes none of them.
  if (message.source !== null) return false;
  return editor.profile === null && principalOf(message.actorId) === editor.principal;
}

/** What every message must satisfy, whoever writes it and wherever it goes. */
export function assertContent(
  text: string,
  attachmentIds: readonly string[],
  blocks: readonly Block[] = [],
): void {
  assertText(text, attachmentIds.length, blocks);
  if (attachmentIds.length > MAX_ATTACHMENTS) {
    throw invalidMessage(`A message carries up to ${MAX_ATTACHMENTS} files.`);
  }
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw invalidMessage("A message can't carry the same file twice.");
  }
}

/**
 * What a message's text and data must satisfy, when it is written and when it
 * is edited. A message with files or data needs no text.
 */
export function assertText(
  text: string,
  attachmentCount: number,
  blocks: readonly Block[] = [],
): void {
  assertBlocks(blocks);
  if (writtenLength(text) > MAX_TEXT_LENGTH) {
    throw invalidMessage(
      `A message holds up to ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
      "Put longer text in a file and attach it.",
    );
  }
  if (text.trim() === "" && attachmentCount === 0 && blocks.length === 0) {
    throw invalidMessage("A message needs text, unless it has attachments or data.");
  }
}
