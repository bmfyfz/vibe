import type { Actor } from "@vibe/contracts";
import type { Authorizer, Caller } from "@vibe/identity";

import { findMentions, namedIn, type SettledText, settleMentions } from "../domain/mentions.ts";
import type { MessagingQueries, VibeRecord } from "./ports.ts";

/** The actors a caller can see on a vibe: who `actors` lists, and who a handle can settle on. */
export class VisibleActors {
  constructor(
    private readonly queries: MessagingQueries,
    private readonly authorizer: Authorizer,
  ) {}

  /**
   * The team's people, the caller's own profiles, and the profiles that have
   * written in a channel the caller can read. An agent that has only written
   * where the caller can't look stays unknown to them.
   */
  async list(caller: Caller, vibe: VibeRecord): Promise<Actor[]> {
    const [all, written, scope] = await Promise.all([
      this.queries.listActors(vibe.teamId),
      this.queries.listAuthors(vibe.id),
      this.authorizer.scope(caller, vibe.id),
    ]);
    const seen = new Set(
      written.filter((author) => scope.allows(author.channel)).map((author) => author.actorId),
    );
    return all.filter(
      (actor) =>
        actor.profile === null || actor.principal === caller.principal || seen.has(actor.actor),
    );
  }

  /**
   * Settles the mentions in a text among the actors its writer can see, so a
   * write never reveals an actor that `actors` wouldn't show them.
   */
  async settle(
    caller: Caller,
    vibe: VibeRecord,
    text: string,
    how: "handles" | "exact" = "handles",
  ): Promise<SettledText> {
    const tokens = findMentions(text);
    if (tokens.length === 0) return { text, mentions: [], unresolved: [] };

    const { handles, ids } = namedIn(tokens);
    const named = new Set([...handles, ...ids]);
    const visible = (await this.list(caller, vibe)).filter(
      (actor) => named.has(actor.handle) || named.has(actor.actor),
    );
    return settleMentions(
      text,
      visible.map((actor) => ({ id: actor.actor, handle: actor.handle })),
      how,
    );
  }

  /**
   * The actor ID a `mentions` filter names: an actor ID as given, or a handle's.
   * A handle no one has matches nothing.
   */
  async idOf(vibe: VibeRecord, named: string): Promise<string> {
    if (named.startsWith("vibe:")) return named;
    const handle = named.replace(/^@/, "").toLowerCase();
    const all = await this.queries.listActors(vibe.teamId);
    return all.find((actor) => actor.handle === handle)?.actor ?? named;
  }
}
