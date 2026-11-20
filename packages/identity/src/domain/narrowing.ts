import { forbidden, invalid } from "@vibe/kernel";

import type { Caller } from "./caller.ts";
import { type Can, parseCan } from "./grant.ts";

/**
 * A limit a caller acts under: the most it can do at each channel pattern,
 * wherever its principal can do as much. It only ever takes access away. A
 * delegated token carries one, and so does a request that asks to be held to less.
 */
export interface Narrowing {
  /** The one vibe the caller works in, or `null` when the limit holds in whichever vibe it names. */
  readonly vibeId: string | null;
  /** Each limit narrows what the ones before it left. */
  readonly limits: readonly Can[];
  /** When the credential that carries it stops working, when it does. */
  readonly expiresAt: number | null;
}

/** The longest a delegated token lasts. Whoever needs longer mints another. */
export const MAX_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
const MIN_TOKEN_TTL_MS = 1000;

/**
 * The caller, held to a limit. An owner under a limit counts as a member:
 * what only an owner may do is never passed on. Limits add up, each narrowing
 * what the others left.
 */
export function narrow(caller: Caller, limit: Omit<Narrowing, "limits"> & { can: Can }): Caller {
  const held = caller.narrowed;
  return {
    ...caller,
    role: caller.role === "owner" ? "member" : caller.role,
    narrowed: {
      vibeId: held?.vibeId ?? limit.vibeId,
      limits: [...(held?.limits ?? []), limit.can],
      expiresAt: held?.expiresAt ?? limit.expiresAt,
    },
  };
}

/**
 * Refuses a narrowed caller something that is never delegated, whatever its
 * limit says: changing who may do what, and anything that would keep acting
 * after the caller's credential has run out.
 */
export function refuseNarrowed(caller: Caller, what: string): void {
  if (caller.narrowed === null) return;
  throw forbidden(
    "forbidden",
    `A narrowed token can't ${what}.`,
    "Use the token it was narrowed from.",
  );
}

/**
 * Reads the limits a request asks to be held to: one map from channel pattern
 * to permissions, or a list of them.
 */
export function parseLimits(input: unknown): Can[] {
  const maps = Array.isArray(input) ? input : [input];
  if (maps.length === 0 || maps.length > 8) throw invalidCan();
  return maps.map((map) => {
    if (map === null || typeof map !== "object" || Array.isArray(map)) throw invalidCan();
    return parseCan(map as Record<string, unknown>, "narrowing");
  });
}

const invalidCan = () =>
  invalid(
    "invalid_can",
    "A narrowing is a map from channel pattern to permissions.",
    `Such as { "dev/": ["read", "post"] }, or --can 'dev/=read,post'.`,
  );

/** How long a delegated token lasts, from what its minter asked for. */
export function parseTtl(ms: number | undefined): number {
  const ttl = ms ?? DEFAULT_TOKEN_TTL_MS;
  if (Number.isFinite(ttl) && ttl >= MIN_TOKEN_TTL_MS && ttl <= MAX_TOKEN_TTL_MS) return ttl;
  throw invalid(
    "invalid_ttl",
    "A delegated token lasts from a second to 24 hours.",
    "Such as --ttl 1h. For longer, mint another when it runs out.",
  );
}
