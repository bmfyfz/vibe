import { formatChannelPattern, invalid, notFound, parseChannelPattern } from "@vibe/kernel";

import { isPermission, type Permission, PERMISSIONS } from "./role.ts";

/**
 * Who a grant names: one person or one service, every person or every service
 * on the team, or everyone that something else already lets in. `everyone`
 * never lets anyone in by itself.
 */
export type GrantPrincipal =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "service"; readonly id: string }
  | { readonly kind: "all-users" }
  | { readonly kind: "all-services" }
  | { readonly kind: "everyone" };

/** What a grant gives at each channel pattern, keyed by the pattern as written: `*`, `dev`, `www/`. */
export type Can = Readonly<Record<string, readonly Permission[]>>;

/** Permissions at channel patterns, for the principals it names. */
export interface Grant {
  /** Its number within the vibe. Shown as `g4`. */
  readonly n: number;
  readonly principals: readonly GrantPrincipal[];
  readonly can: Can;
}

export const MAX_PATTERNS_PER_GRANT = 50;
export const MAX_PRINCIPALS_PER_GRANT = 100;

/**
 * What every vibe starts with. `g1`: every person on the team can do
 * everything, as far as their role allows. `g2`: every service can read, write
 * and sync everywhere, and can't change who else may. They stay in force until
 * someone changes them.
 */
export const DEFAULT_GRANTS: readonly Grant[] = [
  { n: 1, principals: [{ kind: "all-users" }], can: { "*": PERMISSIONS } },
  {
    n: 2,
    principals: [{ kind: "all-services" }],
    can: { "*": ["read", "post", "react", "label", "sync"] },
  },
];

export function grantId(n: number): string {
  return `g${n}`;
}

export function parseGrantId(id: string): number {
  const match = /^g([1-9]\d{0,8})$/.exec(id);
  if (!match?.[1]) throw grantNotFound(id);
  return Number(match[1]);
}

export const grantNotFound = (id: string) =>
  notFound("grant_not_found", `This vibe has no grant ${id}.`, "`vibe grants` lists them.");

/** What a map from pattern to permissions is read for: it says which error a bad one gets. */
type CanOf = "grant" | "narrowing";
const CODE: Record<CanOf, string> = { grant: "invalid_grant", narrowing: "invalid_can" };

/**
 * Reads what a grant gives, or what a narrowing leaves, as people write it:
 * each pattern with `all`, `none`, or a list of permissions. Patterns come
 * back in their one canonical spelling.
 */
export function parseCan(input: Readonly<Record<string, unknown>>, of: CanOf = "grant"): Can {
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > MAX_PATTERNS_PER_GRANT) {
    throw invalid(
      CODE[of],
      `A ${of} gives permissions at 1 to ${MAX_PATTERNS_PER_GRANT} channel patterns.`,
      "Such as { 'security/': 'all' }, or --can 'security/=read,post'.",
    );
  }
  const can: Record<string, Permission[]> = {};
  for (const [pattern, given] of entries) {
    if (pattern === "") {
      throw invalid(CODE[of], `A ${of} needs a channel pattern.`, "Use * for every channel.");
    }
    can[formatChannelPattern(parseChannelPattern(pattern))] = parsePermissions(given, of);
  }
  return can;
}

function parsePermissions(given: unknown, of: CanOf): Permission[] {
  if (given === "all") return [...PERMISSIONS];
  if (given === "none") return [];
  const names = typeof given === "string" ? given.split(",").map((name) => name.trim()) : given;
  if (!Array.isArray(names) || !names.every((name): name is string => typeof name === "string")) {
    throw invalidPermissions(String(given), of);
  }
  const unknown = names.find((name) => !isPermission(name));
  if (unknown !== undefined) throw invalidPermissions(unknown, of);
  return PERMISSIONS.filter((permission) => names.includes(permission));
}

const invalidPermissions = (given: string, of: CanOf) =>
  invalid(
    CODE[of],
    `"${given}" is not a permission.`,
    `Use all, none, or a list of ${PERMISSIONS.join(", ")}.`,
  );

export function samePrincipal(a: GrantPrincipal, b: GrantPrincipal): boolean {
  if (a.kind !== b.kind) return false;
  return !("id" in a) || a.id === (b as typeof a).id;
}
