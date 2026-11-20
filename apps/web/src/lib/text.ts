import type { Actor, Message } from "@vibe/sdk";

/** How an actor is shown: a person by name, a profile with who is behind it. */
export function who(actor: Pick<Actor, "name" | "handle" | "profile">): string {
  if (actor.profile === null) return actor.name;
  return `${actor.name} via ${actor.handle.split("/")[0] ?? actor.handle}`;
}

/**
 * The scheme the page's own links to a mentioned actor carry, so the renderer
 * can tell them from the text's. It is made up anew each time the page loads:
 * a message can't spell it, so no text can dress a link up as a mention of
 * someone it doesn't mention.
 */
export const MENTION_SCHEME = `mention-${crypto.randomUUID().replaceAll("-", "")}:`;

/**
 * A message's text, ready to be read as Markdown: each stored `@[actor-id]`
 * becomes a link the renderer shows as a mention, by the handle the actor has now.
 */
export function withMentions(message: Pick<Message, "text" | "mentions">): string {
  let text = message.text;
  for (const mention of message.mentions) {
    const link = `[@${mention.handle}](${MENTION_SCHEME}${encodeURIComponent(mention.actor)})`;
    text = text.replaceAll(`@[${mention.actor}]`, link);
  }
  return text;
}

/** A message's text as one plain line, for a strip: Markdown's marks and line breaks left out. */
export function firstLines(message: Pick<Message, "text" | "mentions">): string {
  let text = message.text;
  for (const mention of message.mentions) {
    text = text.replaceAll(`@[${mention.actor}]`, `@${mention.handle}`);
  }
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A size in bytes, as people say it. */
export function bytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} kB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The handle being typed at the caret, when the text before it ends in one:
 * `@ad` gives `ad`. `null` when the caret isn't in a mention.
 */
export function mentionAt(text: string, caret: number): { start: number; typed: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s(])@([a-z0-9][a-z0-9/-]{0,40})?$/i.exec(before);
  if (!match) return null;
  const typed = match[1] ?? "";
  return { start: caret - typed.length - 1, typed: typed.toLowerCase() };
}
