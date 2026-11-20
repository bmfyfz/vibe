// Slack's own formatting, "mrkdwn", read into Markdown. What goes the other
// way needs no translation: Slack takes Markdown in `markdown_text`.

import { outsideCode, userMention } from "../../application/platform.ts";

/** What a `<…>` token stands for. */
function reference(inner: string): string {
  const [target = "", label] = splitOnce(inner, "|");
  if (target.startsWith("@")) return userMention(target.slice(1).split("|")[0] ?? "");
  if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
  if (target.startsWith("!")) {
    // `<!here>`, `<!channel>`, a user group, a date: Slack's own notices.
    // Written so that it names no one here: `@here` is nobody's handle to take.
    const notice = label ?? `@${target.slice(1).split("^")[0] ?? ""}`;
    return notice.replace(/^@/, "@\u200b");
  }
  if (target.startsWith("mailto:")) return label ?? target.slice("mailto:".length);
  if (label === undefined || label === target) return target;
  return `[${label.replaceAll("]", "\\]")}](${target.replaceAll(")", "%29")})`;
}

function splitOnce(text: string, at: string): [string, string | undefined] {
  const index = text.indexOf(at);
  return index === -1 ? [text, undefined] : [text.slice(0, index), text.slice(index + 1)];
}

const unescaped = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/**
 * A Slack message's text as Markdown: links, bold and strikethrough in
 * Markdown's spelling, Slack's three escapes undone, and each mention of a
 * user marked with `userMention`, for whoever brings the message in to settle.
 */
export function fromMrkdwn(text: string): string {
  const formatted = outsideCode(text, (plain) =>
    plain
      .replace(/<([^<>\n]+)>/g, (_, inner: string) => reference(inner))
      // Slack's bold is one star, and its strikethrough one tilde.
      .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "**$1**")
      .replace(/(?<![\w~])~(?=\S)([^~\n]+?)(?<=\S)~(?![\w~])/g, "~~$1~~"),
  );
  return unescaped(formatted);
}

// The reactions Vibe names otherwise than Slack does.
const TO_SLACK: Record<string, string> = {
  thumbs_up: "thumbsup",
  thumbs_down: "thumbsdown",
  thinking: "thinking_face",
  robot: "robot_face",
  hourglass: "hourglass_flowing_sand",
};
const FROM_SLACK: Record<string, string> = Object.fromEntries(
  Object.entries(TO_SLACK).map(([vibe, slack]) => [slack, vibe]),
);

/** A reaction as Slack names it, or `null` for one that has no name there: an emoji stored as itself. */
export function toSlackEmoji(emoji: string): string | null {
  const name = (Object.hasOwn(TO_SLACK, emoji) ? TO_SLACK[emoji] : undefined) ?? emoji;
  return /^[a-z0-9_+-]+$/.test(name) ? name : null;
}

/** A Slack reaction as Vibe names it. A skin tone is left out: it is the same reaction. */
export function fromSlackEmoji(reaction: string): string {
  const name = reaction.split("::")[0] ?? reaction;
  return (Object.hasOwn(FROM_SLACK, name) ? FROM_SLACK[name] : undefined) ?? name;
}

/**
 * A vibe message's prose with nothing in it that Slack reads as a mention or
 * a notice of its own: `<!channel>`, `<@U…>`, `@here`. An invisible space
 * breaks each, and leaves the words as they were written.
 */
export function quietForSlack(prose: string): string {
  return prose
    .replace(/<(?=[!@])/g, "<\u200b")
    .replace(/@(?=(?:channel|here|everyone)\b)/gi, "@\u200b");
}
