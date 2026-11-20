import {
  type BeginUnitOfWork,
  type Clock,
  forbidden,
  notFound,
  principalId,
  type PrincipalKind,
  principalKindOf,
} from "@vibe/kernel";

import type { Caller } from "../domain/caller.ts";
import type { Can } from "../domain/grant.ts";
import { parseHandle } from "../domain/handle.ts";
import { refuseNarrowed } from "../domain/narrowing.ts";
import type { TokenKind } from "../domain/token.ts";
import { DEFAULT_TEAM } from "./identity-service.ts";
import type { DelegatedToken, IdentityRepository, Token } from "./ports.ts";
import { serviceNotFound } from "./services.ts";

/** A token as its holder is shown it: everything but the secret, which nobody is shown twice. */
export interface TokenView {
  id: string;
  kind: TokenKind;
  /** What it was minted for, when its minter said: `initial`, `login`, a name of their own. */
  label: string | null;
  createdAt: number;
  /** When it ends by itself. `null` for a token of a principal's own, which lasts until revoked. */
  expiresAt: number | null;
  /** For a delegated token: the vibe it works in, the profile it writes as, and the most it can do. */
  delegated: { vibeId: string; profile: string; can: Can; mintedWith: string | null } | null;
  /** Set on a token that was revoked. A list holds none: what it lists works. */
  revokedAt: number | null;
  /** Whether it is the token the caller is using right now. */
  current: boolean;
}

/** Whose tokens: a person or a service, by kind and ID. */
interface Holder {
  kind: PrincipalKind;
  id: string;
}

/**
 * Seeing which tokens a principal has, and revoking one. A token is listed by
 * its ID and what it is for, never by its secret, which was shown once.
 *
 * Who may: a principal, for its own tokens and the delegated ones minted from
 * it. A team owner, for a service's, as they mint them. The operator, for a
 * person's, as they mint them. Never a caller under a limit: what it holds is
 * less than a token, and it must not take its principal's away.
 *
 * Revoking only takes access away, so it is safe to repeat: a token that is
 * already revoked is answered as revoked.
 */
export class HeldTokens {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** The caller's own tokens, and the delegated tokens minted from them, that work now. */
  async mine(caller: Caller): Promise<TokenView[]> {
    refuseNarrowed(caller, "list tokens");
    return this.list(holderOf(caller), caller);
  }

  /**
   * Revokes one of the caller's own tokens, or a delegated one minted from
   * them. It may be the token the request came with: that request is its last.
   *
   * @throws `token_not_found` for a token that isn't theirs, or isn't at all.
   */
  async revokeMine(caller: Caller, id: string): Promise<TokenView> {
    refuseNarrowed(caller, "revoke tokens");
    return this.revoke(holderOf(caller), id, caller);
  }

  /** A service's tokens, for a team owner. */
  async ofService(caller: Caller, name: string): Promise<TokenView[]> {
    return this.list(await this.service(caller, name, "list a service's tokens"), caller);
  }

  /** Revokes one of a service's tokens, as a team owner. Its other tokens keep working. */
  async revokeOfService(caller: Caller, name: string, id: string): Promise<TokenView> {
    return this.revoke(await this.service(caller, name, "revoke a service's token"), id, caller);
  }

  /** An operator's action: a person's tokens. */
  async ofUser(handle: string, team?: string): Promise<TokenView[]> {
    return this.list(await this.user(handle, team), null);
  }

  /** An operator's action: revokes one of a person's tokens, such as one they lost. */
  async revokeOfUser(handle: string, id: string, team?: string): Promise<TokenView> {
    return this.revoke(await this.user(handle, team), id, null);
  }

  private async list(holder: Holder, caller: Caller | null): Promise<TokenView[]> {
    const { repository, clock } = this;
    const [own, delegated] = await Promise.all([
      repository.listTokens(holder.kind, holder.id),
      repository.listDelegatedTokens(principalId(holder.kind, holder.id), clock.now()),
    ]);
    return [
      ...own.map((token) => ownView(holder.kind, token, caller)),
      ...delegated.map((token) => delegatedView(token)),
    ];
  }

  private async revoke(holder: Holder, id: string, caller: Caller | null): Promise<TokenView> {
    const { repository, begin, clock } = this;
    const now = clock.now();
    // The ID says which kind it is, so only one table is asked.
    if (id.startsWith("dt_")) {
      const token = await repository.findDelegatedTokenById(
        principalId(holder.kind, holder.id),
        id,
      );
      if (!token) throw tokenNotFound(id);
      if (token.revokedAt !== null) return delegatedView(token);
      const uow = begin();
      repository.revokeDelegatedToken(uow, token.id, now);
      await uow.commit();
      return delegatedView({ ...token, revokedAt: now });
    }
    const token = await repository.findToken(holder.kind, holder.id, id);
    if (!token) throw tokenNotFound(id);
    if (token.revokedAt !== null) return ownView(holder.kind, token, caller);
    const uow = begin();
    repository.revokeToken(uow, holder.kind, token.id, now);
    await uow.commit();
    return ownView(holder.kind, { ...token, revokedAt: now }, caller);
  }

  private async service(caller: Caller, name: string, what: string): Promise<Holder> {
    if (caller.role !== "owner") throw forbidden("forbidden", `Only a team owner can ${what}.`);
    const service = await this.repository.findServiceByName(caller.teamId, parseHandle(name));
    if (!service) throw serviceNotFound(name);
    return { kind: "service", id: service.id };
  }

  private async user(handle: string, team?: string): Promise<Holder> {
    const parsed = parseHandle(handle);
    const found = await this.repository.findTeamByName((team ?? DEFAULT_TEAM).toLowerCase());
    const user = found && (await this.repository.findUserByHandle(found.id, parsed));
    if (!user) throw notFound("user_not_found", `No one on this team has the handle ${parsed}.`);
    return { kind: "user", id: user.id };
  }
}

function holderOf(caller: Caller): Holder {
  const kind = principalKindOf(caller.principal);
  if (kind === null) throw forbidden("forbidden", "Only a person or a service holds tokens.");
  return { kind, id: caller.principal.slice(caller.principal.lastIndexOf(":") + 1) };
}

function ownView(kind: PrincipalKind, token: Token, caller: Caller | null): TokenView {
  return {
    id: token.id,
    kind,
    label: token.label,
    createdAt: token.createdAt,
    expiresAt: null,
    delegated: null,
    revokedAt: token.revokedAt,
    current: caller?.credential?.kind === "token" && caller.credential.id === token.id,
  };
}

function delegatedView(token: DelegatedToken): TokenView {
  return {
    id: token.id,
    kind: "delegated",
    label: null,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    delegated: {
      vibeId: token.vibeId,
      profile: token.profile,
      can: token.can,
      mintedWith: token.mintedWith,
    },
    revokedAt: token.revokedAt,
    // Whoever lists tokens is not under a limit, so it is not using one of these.
    current: false,
  };
}

export const tokenNotFound = (id: string) =>
  notFound(
    "token_not_found",
    `There is no token ${id} to revoke, or it isn't yours.`,
    "`vibe tokens` lists the ones you have.",
  );
