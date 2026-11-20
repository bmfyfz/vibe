import { newId, type UnitOfWork } from "@vibe/kernel";

import { generateToken, hashToken, type TokenKind } from "../domain/token.ts";
import type { IdentityRepository } from "./ports.ts";

/**
 * Adds a new token for a person or a service to a unit of work.
 *
 * @param owner The ID of the user or the service, not its principal ID.
 * @returns The secret. It is shown this once: only its hash is stored.
 */
export async function mintToken(
  repository: IdentityRepository,
  uow: UnitOfWork,
  kind: Exclude<TokenKind, "delegated">,
  owner: string,
  label: string | null,
  now: number,
): Promise<string> {
  const token = generateToken(kind);
  repository.addToken(uow, kind, {
    id: newId("tok", now),
    hash: await hashToken(token),
    owner,
    label,
    createdAt: now,
    revokedAt: null,
  });
  return token;
}
