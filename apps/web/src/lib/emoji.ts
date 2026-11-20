// Reactions are stored by name. These are the ones the page offers, with the
// character each is shown as. A reaction with another name is shown by name.
const GLYPHS: Record<string, string> = {
  thumbs_up: "👍",
  thumbs_down: "👎",
  eyes: "👀",
  heart: "❤️",
  tada: "🎉",
  rocket: "🚀",
  white_check_mark: "✅",
  x: "❌",
  smile: "😄",
  joy: "😂",
  confused: "😕",
  thinking: "🤔",
  pray: "🙏",
  raised_hands: "🙌",
  clap: "👏",
  wave: "👋",
  fire: "🔥",
  "100": "💯",
  sparkles: "✨",
  warning: "⚠️",
  bug: "🐛",
  bulb: "💡",
  construction: "🚧",
  hourglass: "⏳",
  robot: "🤖",
};

/** The reactions offered for picking, the most used first. */
export const OFFERED: readonly string[] = [
  "thumbs_up",
  "eyes",
  "white_check_mark",
  "heart",
  "tada",
  "rocket",
  "thinking",
  "pray",
  "x",
  "bug",
  "fire",
  "thumbs_down",
];

/** How a reaction is shown: its character, or for one the page doesn't know, itself or its name in colons. */
export function glyph(emoji: string): string {
  return GLYPHS[emoji] ?? (/^[a-z0-9_+-]+$/.test(emoji) ? `:${emoji}:` : emoji);
}

/** What a reaction is called aloud. */
export function spoken(emoji: string): string {
  return emoji.replaceAll("_", " ");
}
