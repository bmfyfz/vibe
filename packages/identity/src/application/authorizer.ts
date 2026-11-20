import { type ChannelScope, forbidden } from "@vibe/kernel";

import { Access, AccessPolicy } from "../domain/access-policy.ts";
import type { Caller } from "../domain/caller.ts";
import { DEFAULT_GRANTS, type Grant } from "../domain/grant.ts";
import { type Permission, roleAllows } from "../domain/role.ts";
import type { GrantRepository, StoredGrants } from "./ports.ts";

export interface Resource {
  readonly vibeId: string;
  /**
   * A channel's path. `null` asks about the vibe as a whole: whether the caller
   * holds the permission in some channel, as an upload needs before it has one.
   */
  readonly channel: string | null;
}

/** The question every other context asks before it reads or writes. */
export interface Authorizer {
  /** Resolves when the caller may do this. Throws `forbidden` otherwise. */
  require(caller: Caller, permission: Permission, resource: Resource): Promise<void>;
  /**
   * Resolves when the caller holds the permission at `*`, the pattern for every
   * channel: what it takes to change something the whole vibe shares. A team
   * owner always does.
   *
   * @param what What the caller set out to do, to say in the refusal.
   */
  requireAtAll(caller: Caller, permission: Permission, vibeId: string, what: string): Promise<void>;
  /** Everything the caller may do there, for a handler that decides on more than one permission. */
  permissions(caller: Caller, resource: Resource): Promise<ReadonlySet<Permission>>;
  /** The channels of a vibe the caller holds a permission in, `read` unless said, to filter what a query returns. */
  scope(caller: Caller, vibeId: string, permission?: Permission): Promise<ChannelScope>;
}

/**
 * Access by the vibe's grants. A profile has no access of its own: what counts
 * is the principal that holds the credential, and that principal's role. A
 * caller under a limit, such as a delegated token's, has what both the grants
 * and the limit allow. A change to a grant applies from the next request,
 * since every request reads them.
 */
export class GrantAuthorizer implements Authorizer {
  constructor(private readonly grants: GrantRepository) {}

  async require(caller: Caller, permission: Permission, resource: Resource): Promise<void> {
    const can = await this.permissions(caller, resource);
    if (can.has(permission)) return;

    const where = resource.channel === null ? "this vibe" : `the ${resource.channel} channel`;
    if (!roleAllows(caller.role, permission)) {
      throw forbidden(
        "forbidden",
        `Your role, ${caller.role}, can't ${permission} in ${where}.`,
        "Ask a team owner for a role that allows it.",
      );
    }
    if (caller.narrowed !== null) {
      // The limit, the grants, or both: either way, what the token can do is in `whoami`.
      throw forbidden(
        "forbidden",
        `This token is narrowed, and can't ${permission} in ${where}.`,
        "`vibe whoami` shows what it can do in each channel.",
      );
    }
    throw forbidden(
      "forbidden",
      `This vibe's grants don't let you ${permission} in ${where}.`,
      resource.channel === null
        ? "`vibe whoami` shows what you can do in each channel."
        : `\`vibe grants explain ${resource.channel}\` shows which grant decides.`,
    );
  }

  async requireAtAll(
    caller: Caller,
    permission: Permission,
    vibeId: string,
    what: string,
  ): Promise<void> {
    if (caller.role === "owner") return;
    const access = await this.accessOf(caller, vibeId);
    if (access.at({ kind: "all" }).can.has(permission)) return;
    throw forbidden("forbidden", `To ${what}, you need ${permission} at *, in every channel.`);
  }

  async permissions(caller: Caller, resource: Resource): Promise<ReadonlySet<Permission>> {
    const access = await this.accessOf(caller, resource.vibeId);
    return resource.channel === null ? access.somewhere() : access.in(resource.channel).can;
  }

  async scope(
    caller: Caller,
    vibeId: string,
    permission: Permission = "read",
  ): Promise<ChannelScope> {
    return (await this.accessOf(caller, vibeId)).scope(permission);
  }

  private async accessOf(caller: Caller, vibeId: string): Promise<Access> {
    return accessFor(await this.grants.current(vibeId), vibeId, caller);
  }
}

/**
 * A caller's access to a vibe: what the grants give its principal, less
 * whatever the limit it acts under takes away.
 */
export function accessFor(stored: StoredGrants, vibeId: string, caller: Caller): Access {
  const { narrowed } = caller;
  if (narrowed !== null && narrowed.vibeId !== null && narrowed.vibeId !== vibeId) {
    return Access.NONE;
  }
  const whole = new AccessPolicy(inForce(stored)).for(caller);
  return (narrowed?.limits ?? []).reduce((access, limit) => access.narrowedTo(limit), whole);
}

/** The grants that apply now: the defaults, for a vibe whose grants nobody has changed. */
export function inForce(stored: StoredGrants): readonly Grant[] {
  return stored.last === 0 ? DEFAULT_GRANTS : stored.grants;
}
