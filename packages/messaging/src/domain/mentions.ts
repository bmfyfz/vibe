/** An actor a mention can settle on. */
export interface KnownActor {
  readonly id: string;
  readonly handle: string;
}

/** Something in a message's text that reads as a mention. */
export interface MentionToken {
  readonly start: number;
  readonly end: number;
  /** A person's handle, such as `ada`. `null` for the exact form. */
  readonly handle: string | null;
  /** The `/fx` of `@ada/fx`, without the slash. */
  readonly profile: string | null;
  /** The actor ID of the exact form, `@[actor-id]`. */
  readonly actorId: string | null;
}

export interface SettledText {
  /** The text to store, with each settled handle rewritten as `@[actor-id]`. */
  readonly text: string;
  /** The actors the text mentions, each once, in order. */
  readonly mentions: readonly string[];
  /** What was written as a mention and stayed plain text, such as `@nobody`. */
  readonly unresolved: readonly string[];
}

// A handle, optionally with a profile, or an actor ID in brackets. Not after a
// word character, so an email address isn't a mention.
const MENTION =
  /(?<![\w@/.[\]-])@(?:\[([^\]\s]{1,200})\]|([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)(?:\/([a-z][a-z0-9-]{0,31}))?)(?![\w/])/gi;

/** Finds what reads as a mention. Inline code and code blocks don't count. */
export function findMentions(text: string): MentionToken[] {
  const code = codeMask(text);
  const tokens: MentionToken[] = [];
  for (const match of text.matchAll(MENTION)) {
    if (code[match.index] === 1) continue;
    tokens.push({
      start: match.index,
      end: match.index + match[0].length,
      handle: match[2]?.toLowerCase() ?? null,
      profile: match[3]?.toLowerCase() ?? null,
      actorId: match[1] ?? null,
    });
  }
  return tokens;
}

/** The handles and actor IDs a text names, for looking up who they could mean. */
export function namedIn(tokens: readonly MentionToken[]): { handles: string[]; ids: string[] } {
  const handles = new Set<string>();
  const ids = new Set<string>();
  for (const token of tokens) {
    if (token.actorId !== null) ids.add(token.actorId);
    if (token.handle === null) continue;
    handles.add(token.profile === null ? token.handle : `${token.handle}/${token.profile}`);
  }
  return { handles: [...handles], ids: [...ids] };
}

/**
 * Settles the mentions in a text among the actors its writer can see. A handle
 * that one of them has becomes `@[actor-id]`, which keeps pointing at that
 * actor whatever happens to the handle. Anything else stays as written and
 * mentions no one: a mention never makes a write fail.
 *
 * @param how `exact` settles only the exact form, `@[actor-id]`, and leaves
 *   every handle as the text it is. For text written somewhere else, where
 *   `@ada` names whoever has that name there.
 */
export function settleMentions(
  text: string,
  visible: readonly KnownActor[],
  how: "handles" | "exact" = "handles",
): SettledText {
  const byHandle = new Map(visible.map((actor) => [actor.handle, actor.id]));
  const ids = new Set(visible.map((actor) => actor.id));
  const mentions = new Set<string>();
  const unresolved: string[] = [];
  let out = "";
  let cursor = 0;

  for (const token of findMentions(text)) {
    const written = text.slice(token.start, token.end);
    if (token.actorId !== null) {
      if (ids.has(token.actorId)) mentions.add(token.actorId);
      else unresolved.push(written);
      continue;
    }
    if (token.handle === null || how === "exact") continue;

    // `@ada/ghost` names an agent. With no such agent in sight it mentions no
    // one, rather than paging ada over a name she never went by.
    const handle = token.profile === null ? token.handle : `${token.handle}/${token.profile}`;
    const id = byHandle.get(handle);
    if (id === undefined) {
      unresolved.push(written);
      continue;
    }
    out += `${text.slice(cursor, token.start)}@[${id}]`;
    cursor = token.end;
    mentions.add(id);
  }
  return { text: out + text.slice(cursor), mentions: [...mentions], unresolved };
}

/** How long a text is as its author wrote it: a settled mention counts as one character. */
export function writtenLength(text: string): number {
  return text.replace(/@\[[^\]\s]{1,200}\]/g, "@").length;
}

/** Marks every character that sits in a fenced code block or an inline code span. */
function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let offset = 0;
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== null || marker !== undefined) mask.fill(1, offset, offset + line.length);
    if (fence === null) fence = marker ?? null;
    else if (marker?.startsWith(fence) && line.trim() === marker) fence = null;
    offset += line.length + 1;
  }
  for (const span of text.matchAll(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
    if (mask[span.index] !== 1) mask.fill(1, span.index, span.index + span[0].length);
  }
  return mask;
}
