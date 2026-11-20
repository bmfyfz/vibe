import {
  type BeginUnitOfWork,
  type Clock,
  forbidden,
  newId,
  parseChannelPattern,
} from "@vibe/kernel";

import type { Caller } from "../domain/caller.ts";
import { type Can, parseCan } from "../domain/grant.ts";
import { parseTtl, refuseNarrowed } from "../domain/narrowing.ts";
import { parseProfile } from "../domain/profile.ts";
import { generateToken, hashToken } from "../domain/token.ts";
import { accessFor } from "./authorizer.ts";
import type { GrantRepository, IdentityRepository } from "./ports.ts";

export interface MintDelegatedToken {
  /** The one profile the token writes as. */
  profile: string;
  /** The most the token can do at each channel pattern. */
  can: Readonly<Record<string, unknown>>;
  /** How long it lasts. An hour, when left out. */
  ttlMs?: number | undefined;
}

export interface MintedToken {
  id: string;
  /** The secret, returned this once. */
  token: string;
  profile: string;
  can: Can;
  expiresAt: number;
}

/**
 * Hands part of a caller's access to something that should hold less: an
 * agent in a sandbox, a script, a job. The token it mints works in one vibe,
 * writes as one profile, and ends by itself.
 */
export class Delegation {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly grants: GrantRepository,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Mints a delegated token. It gives nothing its minter doesn't have at each
   * pattern it names, and when it is used it gives no more than its principal
   * has then: access the principal loses, the token loses with it. It works
   * only while the token or the session it was minted with does.
   *
   * @throws `forbidden` for a caller that is itself narrowed, and for a limit
   *   that names a permission the caller doesn't hold at that pattern.
   */
  async mint(caller: Caller, vibeId: string, input: MintDelegatedToken): Promise<MintedToken> {
    const { repository, grants, begin, clock } = this;
    refuseNarrowed(caller, "mint tokens");
    // A token ends with what its minter showed. A caller that showed nothing,
    // such as a principal a schedule acts for, has nothing for it to end with.
    const mintedWith = caller.credential?.id;
    if (mintedWith === undefined) {
      throw forbidden("forbidden", "Only a caller that showed a credential mints a token.");
    }
    const profile = parseProfile(input.profile);
    const can = parseCan(input.can, "narrowing");
    const ttl = parseTtl(input.ttlMs);

    const access = accessFor(await grants.current(vibeId), vibeId, caller);
    for (const [pattern, permissions] of Object.entries(can)) {
      const mine = access.at(parseChannelPattern(pattern)).can;
      const beyond = permissions.find((permission) => !mine.has(permission));
      if (beyond !== undefined) {
        throw forbidden(
          "forbidden",
          `You can't delegate ${beyond} at ${pattern}: a token gives no more than you have.`,
          "`vibe whoami` shows what you can do at each channel pattern.",
        );
      }
    }

    const now = clock.now();
    const token = generateToken("delegated");
    const minted = { id: newId("dt", now), profile, can, expiresAt: now + ttl };
    const uow = begin();
    repository.addDelegatedToken(uow, {
      ...minted,
      hash: await hashToken(token),
      principal: caller.principal,
      vibeId,
      createdBy: caller.actorId,
      createdAt: now,
      // What the minter showed to be let in. The token ends when that does.
      mintedWith,
      revokedAt: null,
    });
    await uow.commit();
    return { ...minted, token };
  }
}
