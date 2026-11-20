import {
  type BeginUnitOfWork,
  type Clock,
  conflict,
  coversPattern,
  forbidden,
  invalid,
  notFound,
  parseChannelPath,
  parseChannelPattern,
  principalId,
  type UnitOfWork,
} from "@vibe/kernel";

import { type Access, AccessPolicy, type Subject } from "../domain/access-policy.ts";
import type { Caller } from "../domain/caller.ts";
import {
  type Can,
  DEFAULT_GRANTS,
  grantId,
  grantNotFound,
  type GrantPrincipal,
  MAX_PRINCIPALS_PER_GRANT,
  parseCan,
  parseGrantId,
  samePrincipal,
} from "../domain/grant.ts";
import { parseHandle } from "../domain/handle.ts";
import { refuseNarrowed } from "../domain/narrowing.ts";
import { type Permission, PERMISSIONS, type Role } from "../domain/role.ts";
import { accessFor, inForce } from "./authorizer.ts";
import type { GrantRepository, IdentityRepository, StoredGrant, StoredGrants } from "./ports.ts";
import { serviceNotFound } from "./services.ts";

/** A principal as a client names it: a person by handle or by ID, a service by name or by ID, or a group. */
export type PrincipalInput =
  | { kind: "user"; handle?: string | undefined; id?: string | undefined }
  | { kind: "service"; name?: string | undefined; id?: string | undefined }
  | { kind: "all-users" }
  | { kind: "all-services" }
  | { kind: "everyone" };

export type PrincipalView =
  | { kind: "user"; id: string; handle: string }
  | { kind: "service"; id: string; name: string }
  | { kind: "all-users" }
  | { kind: "all-services" }
  | { kind: "everyone" };

export interface GrantView {
  id: string;
  principals: PrincipalView[];
  can: Record<string, Permission[]>;
}

export interface Explanation {
  channel: string;
  principal: { id: string; handle: string };
  role: Role;
  /** The pattern that decides the channel, or `null` when no grant reaches this principal there. */
  pattern: string | null;
  /** The grants that decide at that pattern. Tied grants add up. */
  grants: string[];
  /** What those grants give. */
  granted: Permission[];
  /** What is left once the role has capped it. */
  can: Permission[];
}

// A commit that loses a race to another change of the vibe's grants writes
// nothing. So deciding again from fresh grants is safe.
const MAX_ATTEMPTS = 8;

/** A vibe's access policy: the commands that change its grants, and the questions about them. */
export class Grants {
  constructor(
    private readonly grants: GrantRepository,
    private readonly identities: IdentityRepository,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** Lists the vibe's grants. Takes `manage` at `*`. */
  async list(caller: Caller, vibeId: string): Promise<GrantView[]> {
    const stored = await this.grants.current(vibeId);
    this.requireManageEverywhere(
      caller,
      accessFor(stored, vibeId, caller),
      "list this vibe's grants",
    );
    return this.views(caller.teamId, written(stored, 0).grants);
  }

  /** What the caller can do at each channel pattern that decides something for them. */
  async mine(caller: Caller, vibeId: string): Promise<Record<string, Permission[]>> {
    return accessFor(await this.grants.current(vibeId), vibeId, caller).map();
  }

  /**
   * Gives permissions at channel patterns to the principals named. Takes
   * `manage` at each pattern, and gives nothing the caller doesn't have.
   */
  async create(
    caller: Caller,
    vibeId: string,
    input: { principals: readonly PrincipalInput[]; can: Readonly<Record<string, unknown>> },
  ): Promise<GrantView> {
    const principals = await this.resolve(caller.teamId, input.principals);
    const can = parseCan(input.can);
    assertNamesSomeone(principals);

    return this.write(caller, vibeId, (stored, uow, now) => {
      const access = accessOf(stored, caller);
      this.requireChange(caller, access, { n: null, principals, can, was: {} });
      const grant: StoredGrant = {
        n: stored.last + 1,
        principals,
        can,
        createdBy: caller.principal,
        createdAt: now,
        revokedAt: null,
      };
      this.grants.add(uow, vibeId, grant);
      return grant;
    });
  }

  /** Adds and removes principals, and replaces what the grant gives when `can` is passed. */
  async update(
    caller: Caller,
    vibeId: string,
    id: string,
    input: {
      add?: readonly PrincipalInput[] | undefined;
      remove?: readonly PrincipalInput[] | undefined;
      can?: Readonly<Record<string, unknown>> | undefined;
    },
  ): Promise<GrantView> {
    const n = parseGrantId(id);
    const add = await this.resolve(caller.teamId, input.add ?? []);
    const remove = await this.resolve(caller.teamId, input.remove ?? []);
    const can = input.can === undefined ? undefined : parseCan(input.can);

    return this.write(caller, vibeId, (stored, uow) => {
      const grant = find(stored, n, id);
      const kept = grant.principals.filter((p) => !remove.some((gone) => samePrincipal(p, gone)));
      const principals = [...kept, ...add.filter((p) => !kept.some((k) => samePrincipal(k, p)))];
      assertNamesSomeone(principals);

      const access = accessOf(stored, caller);
      const changed = { ...grant, principals, can: can ?? grant.can };
      this.requireChange(caller, access, { ...changed, was: grant.can });
      this.grants.update(uow, vibeId, changed);
      return changed;
    });
  }

  /** Revokes a grant. What it gave stops from the next request. */
  async revoke(caller: Caller, vibeId: string, id: string): Promise<GrantView> {
    const n = parseGrantId(id);
    return this.write(caller, vibeId, (stored, uow, now) => {
      const grant = find(stored, n, id);
      const access = accessOf(stored, caller);
      this.requireChange(caller, access, { ...grant, can: {}, was: grant.can });
      this.grants.update(uow, vibeId, { ...grant, revokedAt: now });
      return grant;
    });
  }

  /**
   * Says which grant decides a channel for someone, and what it comes to.
   * Explaining someone else's access takes `manage` at `*`.
   *
   * @param who A person's handle or a service's name. Omit it to explain the
   *   caller's own access.
   */
  async explain(
    caller: Caller,
    vibeId: string,
    channel: string,
    who: { user?: string | undefined; service?: string | undefined } = {},
  ): Promise<Explanation> {
    const path = parseChannelPath(channel);
    const stored = await this.grants.current(vibeId);
    const subject = await this.subject(caller, who);
    const own = subject.principal === caller.principal;
    const mine = accessFor(stored, vibeId, caller);
    if (!own) this.requireManageEverywhere(caller, mine, "explain someone else's access");

    // The caller's own access is what it has now, under any limit it acts under.
    const decision = (own ? mine : accessOf(stored, subject)).in(path);
    return {
      channel: path,
      principal: { id: subject.principal, handle: subject.handle },
      role: subject.role,
      pattern: decision.pattern,
      grants: [...decision.grants],
      granted: [...decision.granted],
      can: PERMISSIONS.filter((permission) => decision.can.has(permission)),
    };
  }

  /**
   * Makes a channel private, in a unit of work its caller commits: one grant
   * lets the caller in, and one closes the path to everyone else. Takes
   * `manage` at `*` and at the path.
   *
   * @throws `channel_granted` when another grant already reaches the path,
   *   since that grant would still let in the principals it names.
   */
  async closeToAllBut(
    uow: UnitOfWork,
    caller: Caller,
    vibeId: string,
    path: string,
    now: number,
  ): Promise<GrantView[]> {
    refuseNarrowed(caller, "change grants");
    const stored = written(await this.grants.current(vibeId), now);
    this.requireMayClose(caller, accessOf(stored, caller), path);

    // The channel and everything under it, so nothing can be posted beside the door.
    const patterns = [path, `${path}/`];
    const region = parseChannelPattern(`${path}/`);
    const reaches = stored.grants.some((grant) =>
      Object.keys(grant.can).some((pattern) => {
        const where = parseChannelPattern(pattern);
        return pattern === path || coversPattern(region, where);
      }),
    );
    if (reaches) {
      throw conflict(
        "channel_granted",
        `Another grant already reaches ${path}, and would still let in the principals it names.`,
        "`vibe grants` lists them. Change or revoke that grant, or pick another path.",
      );
    }

    this.advance(uow, vibeId, stored);
    const base = { createdBy: caller.principal, createdAt: now, revokedAt: null };
    const mine: StoredGrant = {
      ...base,
      n: stored.last + 1,
      principals: [{ kind: "user", id: caller.principal }],
      can: Object.fromEntries(patterns.map((pattern) => [pattern, [...PERMISSIONS]])),
    };
    const closed: StoredGrant = {
      ...base,
      n: stored.last + 2,
      principals: [{ kind: "everyone" }],
      can: Object.fromEntries(patterns.map((pattern) => [pattern, []])),
    };
    this.grants.add(uow, vibeId, mine);
    this.grants.add(uow, vibeId, closed);
    return this.views(caller.teamId, [mine, closed]);
  }

  /**
   * Refuses a caller who may not make a channel private at a path. Asked before
   * anything is said about the path, so a refusal tells them nothing about
   * what exists there.
   */
  async requirePrivate(caller: Caller, vibeId: string, path: string): Promise<void> {
    refuseNarrowed(caller, "change grants");
    this.requireMayClose(caller, accessOf(await this.grants.current(vibeId), caller), path);
  }

  private requireMayClose(caller: Caller, access: Access, path: string): void {
    this.requireManageEverywhere(caller, access, "create a private channel");
    // Holding manage at * isn't holding it everywhere: a subtree closed to the
    // caller stays closed, and they can't carve a channel of their own out of it.
    if (caller.role !== "owner" && !access.in(path).can.has("manage")) {
      throw forbidden(
        "forbidden",
        `Creating a private channel at ${path} takes manage there, which you don't have.`,
        `\`vibe grants explain ${path}\` shows which grant decides.`,
      );
    }
  }

  /** Whether a failed commit lost a race with another change to the vibe's grants. */
  lostRace(error: unknown): boolean {
    return this.grants.lostRace(error);
  }

  /** Runs one change to the vibe's grants, again from fresh grants when another change got there first. */
  private async write(
    caller: Caller,
    vibeId: string,
    change: (stored: Writable, uow: UnitOfWork, now: number) => StoredGrant,
  ): Promise<GrantView> {
    // Whatever a limit says, who may do what is not a narrowed caller's to change.
    refuseNarrowed(caller, "change grants");
    for (let attempt = 1; ; attempt++) {
      const now = this.clock.now();
      const stored = written(await this.grants.current(vibeId), now);
      const uow = this.begin();
      this.advance(uow, vibeId, stored);
      const grant = change(stored, uow, now);
      try {
        await uow.commit();
        const [view] = await this.views(caller.teamId, [grant]);
        if (!view) throw grantNotFound(grantId(grant.n));
        return view;
      } catch (error) {
        if (!this.grants.lostRace(error) || attempt >= MAX_ATTEMPTS) throw error;
      }
    }
  }

  /**
   * Ties a unit of work to the grants it was decided from. Whether a change is
   * allowed depends on all of a vibe's grants, so the lock is on all of them:
   * if any changed since `stored` was read, the commit fails and the change is
   * decided again. The first change also writes the defaults down, so they can
   * be changed like any other grant.
   */
  private advance(uow: UnitOfWork, vibeId: string, stored: Writable): void {
    this.grants.advance(uow, vibeId, stored.revision);
    for (const grant of stored.unwritten) this.grants.add(uow, vibeId, grant);
  }

  /**
   * The rules for changing a grant: `manage` at every pattern it names, before
   * and after, and nothing given that the caller doesn't have. A team's owners
   * can always change grants, which is how a channel closed to everyone is
   * reopened.
   */
  private requireChange(
    caller: Caller,
    access: Access,
    change: { n: number | null; principals: readonly GrantPrincipal[]; can: Can; was: Can },
  ): void {
    if (caller.role === "owner") return;

    if (change.n === 1) {
      throw forbidden(
        "forbidden",
        "Only a team owner can change or revoke g1, the grant that lets the team in.",
      );
    }
    const group = change.principals.some(
      (principal) => principal.kind === "all-users" || principal.kind === "everyone",
    );
    const closes = Object.values(change.can).some((permissions) => !permissions.includes("read"));
    if (group && closes) {
      throw forbidden(
        "forbidden",
        "Only a team owner can close a channel to everyone, or to every person on the team.",
        "To keep a new channel to yourself, create it with `vibe channels create <channel> --private`.",
      );
    }

    for (const pattern of new Set([...Object.keys(change.was), ...Object.keys(change.can)])) {
      const mine = access.at(parseChannelPattern(pattern)).can;
      if (!mine.has("manage")) {
        throw forbidden(
          "forbidden",
          `Changing a grant at ${pattern} takes manage there, which you don't have.`,
          `\`vibe grants explain\` shows which grant decides a channel for you.`,
        );
      }
      const beyond = (change.can[pattern] ?? []).find((permission) => !mine.has(permission));
      if (beyond !== undefined) {
        throw forbidden(
          "forbidden",
          `You can't grant ${beyond} at ${pattern}: you can't grant more than you have.`,
        );
      }
    }
  }

  /** Whose access a question is about: the caller's own, a person's, or a service's. */
  private async subject(
    caller: Caller,
    who: { user?: string | undefined; service?: string | undefined },
  ): Promise<Subject & { handle: string }> {
    const { identities } = this;
    if (who.user !== undefined && who.service !== undefined) {
      throw invalid("invalid_request", "Name a person or a service to explain, not both.");
    }
    if (who.service !== undefined) {
      const service = await identities.findServiceByName(caller.teamId, parseHandle(who.service));
      if (!service) throw serviceNotFound(who.service);
      return {
        principal: principalId("service", service.id),
        role: "service",
        handle: service.name,
      };
    }
    if (who.user !== undefined) {
      const user = await identities.findUserByHandle(caller.teamId, parseHandle(who.user));
      if (!user) throw userNotFound(who.user);
      return { principal: principalId("user", user.id), role: user.role, handle: user.handle };
    }
    // The caller's own, by its principal: a profile has no access of its own.
    const [person] = await identities.findUsersByPrincipal(caller.teamId, [caller.principal]);
    const [service] = await identities.findServicesByPrincipal(caller.teamId, [caller.principal]);
    const handle = person?.handle ?? service?.name;
    if (handle === undefined) throw userNotFound(caller.handle);
    return { principal: caller.principal, role: caller.role, handle };
  }

  private requireManageEverywhere(caller: Caller, access: Access, what: string): void {
    if (caller.role === "owner") return;
    if (access.at({ kind: "all" }).can.has("manage")) return;
    throw forbidden("forbidden", `To ${what}, you need manage at *, in every channel.`);
  }

  /** Turns the principals a client named into the ones a grant stores. */
  private async resolve(
    teamId: string,
    inputs: readonly PrincipalInput[],
  ): Promise<GrantPrincipal[]> {
    const principals: GrantPrincipal[] = [];
    for (const input of inputs) {
      const principal = await this.named(teamId, input);
      if (!principals.some((known) => samePrincipal(known, principal))) principals.push(principal);
    }
    return principals;
  }

  private async named(teamId: string, input: PrincipalInput): Promise<GrantPrincipal> {
    const { identities } = this;
    if (input.kind === "user") {
      const user =
        input.handle !== undefined
          ? await identities.findUserByHandle(teamId, parseHandle(input.handle))
          : (await identities.findUsersByPrincipal(teamId, [input.id ?? ""]))[0];
      if (!user) throw userNotFound(input.handle ?? input.id ?? "");
      return { kind: "user", id: principalId("user", user.id) };
    }
    if (input.kind === "service") {
      // A removed service can't be named: a grant to it would give no one anything.
      const service =
        input.name !== undefined
          ? await identities.findServiceByName(teamId, parseHandle(input.name))
          : (await identities.findServicesByPrincipal(teamId, [input.id ?? ""])).find(
              (found) => found.removedAt === null,
            );
      if (!service) throw serviceNotFound(input.name ?? input.id ?? "");
      return { kind: "service", id: principalId("service", service.id) };
    }
    return { kind: input.kind };
  }

  private async views(teamId: string, grants: readonly StoredGrant[]): Promise<GrantView[]> {
    const ids = [
      ...new Set(
        grants.flatMap((grant) =>
          grant.principals.flatMap((principal) => ("id" in principal ? [principal.id] : [])),
        ),
      ),
    ];
    const users = await this.identities.findUsersByPrincipal(teamId, ids);
    const services = await this.identities.findServicesByPrincipal(teamId, ids);
    const names = new Map([
      ...users.map((user) => [principalId("user", user.id), user.handle] as const),
      ...services.map((service) => [principalId("service", service.id), service.name] as const),
    ]);
    return grants.map((grant) => ({
      id: grantId(grant.n),
      principals: grant.principals.map((principal): PrincipalView => {
        if (principal.kind === "user") {
          return { ...principal, handle: names.get(principal.id) ?? principal.id };
        }
        if (principal.kind === "service") {
          return { ...principal, name: names.get(principal.id) ?? principal.id };
        }
        return principal;
      }),
      can: Object.fromEntries(
        Object.entries(grant.can).map(([pattern, permissions]) => [pattern, [...permissions]]),
      ),
    }));
  }
}

/** A vibe's grants as a change sees them, with the defaults it must write down first, if any. */
interface Writable extends StoredGrants {
  readonly unwritten: readonly StoredGrant[];
}

/**
 * A vibe's grants as a change must see them: where nobody has changed them
 * yet, the defaults stand in, ready to be written down with the change.
 */
function written(stored: StoredGrants, now: number): Writable {
  if (stored.last > 0) return { ...stored, unwritten: [] };
  const grants = DEFAULT_GRANTS.map((grant) => ({
    ...grant,
    createdBy: "vibe",
    createdAt: now,
    revokedAt: null,
  }));
  const last = Math.max(...grants.map((grant) => grant.n));
  return { grants, last, revision: stored.revision, unwritten: grants };
}

function accessOf(stored: StoredGrants, subject: Subject): Access {
  return new AccessPolicy(inForce(stored)).for(subject);
}

function find(stored: StoredGrants, n: number, id: string): StoredGrant {
  const grant = stored.grants.find((candidate) => candidate.n === n);
  if (!grant) throw grantNotFound(id);
  return grant;
}

function assertNamesSomeone(principals: readonly GrantPrincipal[]): void {
  if (principals.length >= 1 && principals.length <= MAX_PRINCIPALS_PER_GRANT) return;
  throw invalid(
    "invalid_grant",
    `A grant names 1 to ${MAX_PRINCIPALS_PER_GRANT} principals.`,
    "To take away everything a grant gives, revoke it.",
  );
}

const userNotFound = (handle: string) =>
  notFound("user_not_found", `No one on this team has the handle ${handle}.`);
