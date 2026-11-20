import type { Narrowing } from "./narrowing.ts";
import type { Role } from "./role.ts";

/**
 * What a caller showed to be recognised: a token of its principal's own, a
 * delegated token, or a browser's session. Known by its ID, never its secret.
 */
export interface Credential {
  readonly kind: "token" | "delegated" | "session";
  readonly id: string;
}

/** The verified identity behind a request. Nothing a client sends sets any of it but the credential. */
export interface Caller {
  /** Who writes are attributed to. The principal, or one of its profiles. */
  readonly actorId: string;
  /** Who holds the credential: a person, `vibe:user:u_…`, or a service, `vibe:service:s_…`. */
  readonly principal: string;
  readonly profile: string | null;
  readonly teamId: string;
  readonly teamName: string;
  /** The actor's handle: `ada`, or `ada/fx` when writing as a profile. */
  readonly handle: string;
  readonly name: string;
  /** The role of the principal: a person's, or `service`. A profile has no permissions of its own. */
  readonly role: Role;
  /**
   * The limit the caller acts under, when its credential or its request sets
   * one. `null` for a caller with the whole access of its principal.
   */
  readonly narrowed: Narrowing | null;
  /**
   * What the caller was recognised by. `null` for a caller that showed
   * nothing, because nobody was there to: a principal a schedule or a watcher
   * acts for.
   */
  readonly credential: Credential | null;
}
