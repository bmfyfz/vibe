import { newSecret, type PrincipalKind } from "@vibe/kernel";

/**
 * What a token is: a person's or a service's own, or one delegated from
 * either. It is in the token's prefix, so a lookup goes to the one table that
 * can hold it.
 */
export type TokenKind = PrincipalKind | "delegated";

const PREFIX: Record<TokenKind, string> = {
  user: "vibe_sk",
  service: "vibe_svc",
  delegated: "vibe_dt",
};

export function generateToken(kind: TokenKind): string {
  return newSecret(PREFIX[kind]);
}

/** The kind of a token, or `null` for something that isn't a token of ours. */
export function tokenKind(token: string): TokenKind | null {
  for (const kind of ["user", "service", "delegated"] as const) {
    if (token.startsWith(`${PREFIX[kind]}_`)) return kind;
  }
  return null;
}

/** Tokens are random and long, so a plain SHA-256 is enough: there is nothing to brute-force. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
