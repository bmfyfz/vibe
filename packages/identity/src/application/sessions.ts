import {
  type BeginUnitOfWork,
  type Clock,
  forbidden,
  newId,
  notFound,
  principalKindOf,
  unauthorized,
  type UnitOfWork,
} from "@vibe/kernel";

import type { Caller } from "../domain/caller.ts";
import { refuseNarrowed } from "../domain/narrowing.ts";
import {
  browserName,
  generateSessionSecret,
  isSessionSecret,
  SESSION_TTL_MS,
} from "../domain/session.ts";
import { hashToken, tokenKind } from "../domain/token.ts";
import type { IdentityRepository, User } from "./ports.ts";

/** A session as it is handed to a browser, once. */
export interface OpenedSession {
  /** What goes in the cookie. It is shown this once: only its hash is stored. */
  secret: string;
  expiresAt: number;
}

/** A session as the person it belongs to is shown it. The secret is in its browser, and nowhere else. */
export interface SessionView {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** What the browser called itself when it signed in, to tell one session from another. */
  userAgent: string | null;
  /** How it was opened: with a token, by its ID, or through GitHub. */
  openedWith: string | null;
  /** Whether it is the session the caller is using right now. */
  current: boolean;
}

/** Where a session comes from: what tells it apart later, and what it ends with. */
export interface SessionOrigin {
  /** What the browser calls itself, as its request said. */
  userAgent?: string | null | undefined;
  /** The ID of the token that was shown, when one was. */
  openedWith?: string | null | undefined;
}

/**
 * People signed in from a browser. A session stands for a person, not for a
 * token of theirs: it has the person's whole access, as it is at each request,
 * and ends when they sign out, when they end it from elsewhere, when the
 * token it was opened with is revoked, or after thirty days.
 *
 * The browser holds the session's secret in a cookie that page scripts can't
 * read. So nothing a script could take from the page is good for longer than
 * the page is open.
 */
export class Sessions {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Signs a person in with a token of theirs. The token is used this once and
   * is not kept: the browser goes on with the session.
   *
   * @throws `unauthorized` for a token that is unknown, and `forbidden` for
   *   one that isn't a person's own: a service has no one to sign in, and a
   *   delegated token stands for less than a person.
   */
  async openWithToken(
    token: string,
    userAgent?: string | null,
  ): Promise<OpenedSession & { caller: Caller }> {
    const kind = tokenKind(token);
    if (kind === "service" || kind === "delegated") {
      throw forbidden(
        "forbidden",
        "Only a person signs in to the web app.",
        "Use a token of your own, such as the one `vibe login` saved.",
      );
    }
    const caller =
      kind === null
        ? null
        : await this.repository.findCallerByTokenHash(kind, await hashToken(token));
    if (!caller) {
      throw unauthorized(
        "unauthorized",
        "This token is unknown or revoked.",
        "Ask a team owner for a new one.",
      );
    }
    const userId = caller.principal.slice(caller.principal.lastIndexOf(":") + 1);
    const uow = this.begin();
    // The session ends with the token that opened it: a token someone else
    // got hold of, once revoked, leaves them no session behind.
    const opened = await this.open(uow, userId, {
      userAgent,
      openedWith: caller.credential?.id ?? null,
    });
    await uow.commit();
    return { ...opened, caller };
  }

  /** Adds a new session for a person to a unit of work, and returns what the browser is given. */
  async open(uow: UnitOfWork, userId: string, origin: SessionOrigin = {}): Promise<OpenedSession> {
    const now = this.clock.now();
    const secret = generateSessionSecret();
    const expiresAt = now + SESSION_TTL_MS;
    this.repository.addSession(uow, {
      id: newId("ses", now),
      hash: await hashToken(secret),
      userId,
      createdAt: now,
      expiresAt,
      openedWith: origin.openedWith ?? null,
      userAgent: browserName(origin.userAgent),
    });
    return { secret, expiresAt };
  }

  /**
   * The person a session's secret stands for, as they are now. `null` for a
   * secret that is unknown, signed out, or past its end.
   */
  async authenticate(secret: string): Promise<Caller | null> {
    if (!isSessionSecret(secret)) return null;
    return this.repository.findCallerBySessionHash(await hashToken(secret), this.clock.now());
  }

  /** Signs out: the session is over, wherever its cookie still is. */
  async close(secret: string): Promise<void> {
    if (!isSessionSecret(secret)) return;
    await this.repository.removeSession(await hashToken(secret));
  }

  /**
   * The sessions a person has open, oldest first, whichever way they ask: by
   * a token, or from one of the sessions. A service has none.
   *
   * @throws `forbidden` for a caller under a limit: it stands for less than the person.
   */
  async list(caller: Caller): Promise<SessionView[]> {
    refuseNarrowed(caller, "list sessions");
    const userId = personOf(caller);
    if (userId === null) return [];
    const sessions = await this.repository.listSessions(userId, this.clock.now());
    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      userAgent: session.userAgent,
      openedWith: session.openedWith,
      current: caller.credential?.kind === "session" && caller.credential.id === session.id,
    }));
  }

  /**
   * Ends one of a person's sessions from wherever they are: the browser that
   * holds its cookie is signed out at its next request.
   *
   * @throws `session_not_found` for a session that isn't theirs, or is over.
   */
  async end(caller: Caller, id: string): Promise<void> {
    refuseNarrowed(caller, "end sessions");
    const userId = personOf(caller);
    if (userId === null || !(await this.repository.removeSessionById(userId, id))) {
      throw notFound(
        "session_not_found",
        `You have no session ${id}, or it is already over.`,
        "`vibe sessions` lists the ones you have.",
      );
    }
  }
}

/** The ID of the person a caller is, or `null` for a service. */
function personOf(caller: Caller): string | null {
  if (principalKindOf(caller.principal) !== "user") return null;
  return caller.principal.slice(caller.principal.lastIndexOf(":") + 1);
}

/** A person as the API shows whoever just signed in. */
export type SignedIn = Pick<User, "id" | "handle" | "name" | "role">;
