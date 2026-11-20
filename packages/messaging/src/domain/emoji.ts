import { invalid } from "@vibe/kernel";

// The emoji people actually react with, by the name Vibe stores. Anything else
// with a short name works too; an emoji that isn't listed is stored as itself.
const NAMES: Record<string, string> = {
  "👍": "thumbs_up",
  "👎": "thumbs_down",
  "👀": "eyes",
  "❤": "heart",
  "🎉": "tada",
  "🚀": "rocket",
  "✅": "white_check_mark",
  "❌": "x",
  "😄": "smile",
  "😂": "joy",
  "😕": "confused",
  "🤔": "thinking",
  "🙏": "pray",
  "🙌": "raised_hands",
  "👏": "clap",
  "👋": "wave",
  "🔥": "fire",
  "💯": "100",
  "✨": "sparkles",
  "⚠": "warning",
  "🐛": "bug",
  "💡": "bulb",
  "🚧": "construction",
  "⏳": "hourglass",
  "🤖": "robot",
};

const ALIASES: Record<string, string> = {
  "+1": "thumbs_up",
  "-1": "thumbs_down",
  thumbsup: "thumbs_up",
  thumbsdown: "thumbs_down",
};

const NAME = /^[a-z0-9_+-]{1,64}$/;
const VARIATION_SELECTOR = /️/g;

/**
 * The one name a reaction is stored under, from a short name such as `eyes`,
 * the same with colons, or the emoji itself. A 👍 and a `+1` are one reaction.
 */
export function normalizeEmoji(input: string): string {
  const raw = input.trim().replace(VARIATION_SELECTOR, "");
  // Looked up as the tables' own entries only: `constructor` names no emoji.
  const listed = Object.hasOwn(NAMES, raw) ? NAMES[raw] : undefined;
  if (listed !== undefined) return listed;

  const name = raw.replace(/^:(.+):$/, "$1").toLowerCase();
  if (NAME.test(name)) return (Object.hasOwn(ALIASES, name) ? ALIASES[name] : undefined) ?? name;

  // Not a name, so it must be an emoji: short, and with no plain text in it.
  if (raw.length > 0 && raw.length <= 16 && !/[\p{Cc}\s -~]/u.test(raw)) return raw;
  throw invalid(
    "invalid_emoji",
    `"${input}" is not an emoji.`,
    "Use a short name such as eyes or thumbs_up, or the emoji itself.",
  );
}
