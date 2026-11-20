import {
  type ChannelPattern,
  type ChannelScope,
  compareSpecificity,
  coversPattern,
  formatChannelPattern,
  matchesChannel,
  parseChannelPattern,
  type PrincipalKind,
  principalKindOf,
} from "@vibe/kernel";

import { type Can, type Grant, grantId, type GrantPrincipal } from "./grant.ts";
import { type Permission, PERMISSIONS, type Role, roleAllows } from "./role.ts";

/** Whose access is in question: a principal, and the role that caps it. */
export interface Subject {
  readonly principal: string;
  readonly role: Role;
}

/** What decides a subject's access somewhere, and what it comes to. */
export interface Decision {
  /** The pattern that decided, as written, or `null` when no grant reaches the subject there. */
  readonly pattern: string | null;
  /** The grants that tied at that pattern, whose permissions add up. */
  readonly grants: readonly string[];
  /** What those grants give. */
  readonly granted: readonly Permission[];
  /** What is left once the subject's role has capped it. */
  readonly can: ReadonlySet<Permission>;
}

interface Rule extends Decision {
  readonly where: ChannelPattern;
  readonly pattern: string;
}

const NOTHING: Decision = { pattern: null, grants: [], granted: [], can: new Set() };

/** One vibe's grants, and the rule for how they combine. */
export class AccessPolicy {
  constructor(readonly grants: readonly Grant[]) {}

  /** Works out one subject's access to the whole vibe, ready to be asked about any channel. */
  for(subject: Subject): Access {
    // Collect what names the subject, by pattern. At each pattern only the
    // closest principal counts, and grants tied there add up.
    const byPattern = new Map<string, { closeness: number; grants: Grant[] }>();
    for (const grant of this.grants) {
      const closeness = closenessOf(grant.principals, subject);
      if (closeness === null) continue;
      for (const pattern of Object.keys(grant.can)) {
        const held = byPattern.get(pattern);
        if (!held || closeness < held.closeness)
          byPattern.set(pattern, { closeness, grants: [grant] });
        else if (closeness === held.closeness) held.grants.push(grant);
      }
    }

    const rules: Rule[] = [];
    for (const [pattern, { grants }] of byPattern) {
      const given = new Set(grants.flatMap((grant) => grant.can[pattern] ?? []));
      const granted = PERMISSIONS.filter((permission) => given.has(permission));
      rules.push({
        where: parseChannelPattern(pattern),
        pattern,
        grants: grants.map((grant) => grantId(grant.n)),
        granted,
        // The role is the ceiling. Grants only ever narrow what it allows.
        can: new Set(granted.filter((permission) => roleAllows(subject.role, permission))),
      });
    }
    return new Access(rules.sort((a, b) => compareSpecificity(a.where, b.where)));
  }
}

/** One subject's access to one vibe. */
export class Access {
  /** @param rules What decides at each pattern, the most specific pattern first. */
  constructor(private readonly rules: readonly Rule[]) {}

  /** No access at all: what a caller has in a vibe its credential doesn't reach. */
  static readonly NONE = new Access([]);

  /**
   * What is left of this access under a limit: in every channel, what both
   * this access and the limit allow there. Each side is decided by its own
   * most specific pattern, so a limit of `dev/` leaves nothing outside `dev/`,
   * and a channel closed to the subject stays closed whatever the limit says.
   */
  narrowedTo(limit: Can): Access {
    const cap = new Access(
      Object.entries(limit)
        .map(([pattern, permissions]) => ({
          where: parseChannelPattern(pattern),
          pattern,
          grants: [],
          granted: permissions,
          can: new Set(permissions),
        }))
        .sort((a, b) => compareSpecificity(a.where, b.where)),
    );
    // Deciding at every pattern either side names is enough: the most specific
    // of them that holds a channel is where both sides' deciding patterns meet.
    const patterns = new Map(
      [...this.rules, ...cap.rules].map((rule) => [formatChannelPattern(rule.where), rule.where]),
    );
    const rules = [...patterns].map(([pattern, where]): Rule => {
      const mine = this.at(where);
      const allowed = cap.at(where).can;
      return {
        where,
        pattern,
        grants: mine.grants,
        granted: mine.granted,
        can: new Set([...mine.can].filter((permission) => allowed.has(permission))),
      };
    });
    return new Access(rules.sort((a, b) => compareSpecificity(a.where, b.where)));
  }

  /** What the subject can do in a channel: the most specific pattern that holds it decides. */
  in(channel: string): Decision {
    return this.rules.find((rule) => matchesChannel(rule.where, channel)) ?? NOTHING;
  }

  /**
   * What the subject can do at a pattern as a whole, which is what changing a
   * grant there takes. Grants for channels inside the pattern don't count: they
   * decide for those channels only.
   */
  at(pattern: ChannelPattern): Decision {
    return this.rules.find((rule) => coversPattern(rule.where, pattern)) ?? NOTHING;
  }

  /** Whether the subject holds a permission in some channel, existing or not. */
  anywhere(permission: Permission): boolean {
    return this.rules.some((rule) => rule.can.has(permission));
  }

  /** Every permission the subject holds somewhere. */
  somewhere(): ReadonlySet<Permission> {
    return new Set(PERMISSIONS.filter((permission) => this.anywhere(permission)));
  }

  /** The channels the subject holds a permission in, for read models to filter by. */
  scope(permission: Permission): ChannelScope {
    const all =
      this.rules.some((rule) => rule.where.kind === "all") &&
      this.rules.every((rule) => rule.can.has(permission));
    return { all, allows: (channel) => all || this.in(channel).can.has(permission) };
  }

  /**
   * What the subject can do at each pattern where it can do something. A
   * pattern closed to the subject is left out: its name alone would tell them
   * that a channel they can't see exists.
   */
  map(): Record<string, Permission[]> {
    const map: Record<string, Permission[]> = {};
    for (const rule of [...this.rules].reverse()) {
      if (rule.can.size === 0) continue;
      map[formatChannelPattern(rule.where)] = PERMISSIONS.filter((p) => rule.can.has(p));
    }
    return map;
  }
}

/**
 * How closely a grant names a subject: 0 for the person or the service itself,
 * 1 for its group, 2 for everyone.
 */
function closenessOf(principals: readonly GrantPrincipal[], subject: Subject): number | null {
  const kind = principalKindOf(subject.principal);
  let closest: number | null = null;
  for (const principal of principals) {
    const closeness = closenessTo(principal, subject, kind);
    if (closeness !== null && (closest === null || closeness < closest)) closest = closeness;
  }
  return closest;
}

function closenessTo(
  principal: GrantPrincipal,
  subject: Subject,
  kind: PrincipalKind | null,
): number | null {
  switch (principal.kind) {
    case "user":
    case "service":
      return principal.id === subject.principal ? 0 : null;
    case "all-users":
      return kind === "user" ? 1 : null;
    case "all-services":
      return kind === "service" ? 1 : null;
    case "everyone":
      return 2;
  }
}
