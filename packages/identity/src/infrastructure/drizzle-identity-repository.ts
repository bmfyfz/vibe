import {
  ConstraintViolation,
  principalId,
  type PrincipalKind,
  type UnitOfWork,
} from "@vibe/kernel";
import {
  and,
  asc,
  count,
  type Db,
  enlist,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  schema,
  type SQL,
  sql,
} from "@vibe/store";

import type {
  ActorDirectory,
  BackedDelegatedToken,
  DelegatedToken,
  GrantRepository,
  IdentityRepository,
  Service,
  Session,
  StoredGrant,
  StoredGrants,
  Team,
  Token,
  User,
} from "../application/ports.ts";
import type { Caller } from "../domain/caller.ts";
import type { Can, GrantPrincipal } from "../domain/grant.ts";

const {
  actors,
  delegatedTokens,
  grants,
  policyRevisions,
  services,
  serviceTokens,
  sessions,
  teams,
  tokens,
  users,
} = schema;
const USER = "vibe:user:";
const SERVICE = "vibe:service:";

// D1 takes at most 100 bound parameters in a statement.
const IDS_PER_STATEMENT = 90;

export class DrizzleIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Db) {}

  async findCallerByTokenHash(kind: PrincipalKind, hash: string): Promise<Caller | null> {
    if (kind === "service") {
      const row = await this.db
        .select({ service: services, teamName: teams.name, id: serviceTokens.id })
        .from(serviceTokens)
        .innerJoin(services, eq(services.id, serviceTokens.serviceId))
        .innerJoin(teams, eq(teams.id, services.teamId))
        .where(
          and(
            eq(serviceTokens.hash, hash),
            isNull(serviceTokens.revokedAt),
            isNull(services.removedAt),
          ),
        )
        .get();
      return row ? { ...serviceCaller(row), credential: { kind: "token", id: row.id } } : null;
    }
    const row = await this.db
      .select({ user: users, teamName: teams.name, id: tokens.id })
      .from(tokens)
      .innerJoin(users, eq(users.id, tokens.userId))
      .innerJoin(teams, eq(teams.id, users.teamId))
      .where(and(eq(tokens.hash, hash), isNull(tokens.revokedAt)))
      .get();
    return row ? { ...toCaller(row), credential: { kind: "token", id: row.id } } : null;
  }

  async findDelegatedToken(hash: string, now: number): Promise<BackedDelegatedToken | null> {
    const row = await this.db
      .select({ token: delegatedTokens, backed: sql<number>`${backed(now)}` })
      .from(delegatedTokens)
      .where(eq(delegatedTokens.hash, hash))
      .get();
    return row ? { ...row.token, can: row.token.can as Can, backed: row.backed === 1 } : null;
  }

  async listTokens(kind: PrincipalKind, owner: string): Promise<Token[]> {
    if (kind === "service") {
      const rows = await this.db
        .select()
        .from(serviceTokens)
        .where(and(eq(serviceTokens.serviceId, owner), isNull(serviceTokens.revokedAt)))
        .orderBy(asc(serviceTokens.createdAt), STORED);
      return rows.map(({ serviceId, ...row }) => ({ ...row, owner: serviceId }));
    }
    const rows = await this.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.userId, owner), isNull(tokens.revokedAt)))
      .orderBy(asc(tokens.createdAt), STORED);
    return rows.map(({ userId, ...row }) => ({ ...row, owner: userId }));
  }

  async listDelegatedTokens(principal: string, now: number): Promise<DelegatedToken[]> {
    const rows = await this.db
      .select()
      .from(delegatedTokens)
      .where(
        and(
          eq(delegatedTokens.principal, principal),
          gt(delegatedTokens.expiresAt, now),
          isNull(delegatedTokens.revokedAt),
          sql`${backed(now)} = 1`,
        ),
      )
      .orderBy(asc(delegatedTokens.createdAt), STORED);
    return rows.map((row) => ({ ...row, can: row.can as Can }));
  }

  async findToken(kind: PrincipalKind, owner: string, id: string): Promise<Token | null> {
    if (kind === "service") {
      const row = await this.db
        .select()
        .from(serviceTokens)
        .where(and(eq(serviceTokens.id, id), eq(serviceTokens.serviceId, owner)))
        .get();
      if (!row) return null;
      const { serviceId, ...rest } = row;
      return { ...rest, owner: serviceId };
    }
    const row = await this.db
      .select()
      .from(tokens)
      .where(and(eq(tokens.id, id), eq(tokens.userId, owner)))
      .get();
    if (!row) return null;
    const { userId, ...rest } = row;
    return { ...rest, owner: userId };
  }

  async findDelegatedTokenById(principal: string, id: string): Promise<DelegatedToken | null> {
    const row = await this.db
      .select()
      .from(delegatedTokens)
      .where(and(eq(delegatedTokens.id, id), eq(delegatedTokens.principal, principal)))
      .get();
    return row ? { ...row, can: row.can as Can } : null;
  }

  revokeToken(uow: UnitOfWork, kind: PrincipalKind, id: string, now: number): void {
    if (kind === "service") {
      enlist(uow).add(
        this.db
          .update(serviceTokens)
          .set({ revokedAt: now })
          .where(and(eq(serviceTokens.id, id), isNull(serviceTokens.revokedAt))),
      );
      return;
    }
    enlist(uow).add(
      this.db
        .update(tokens)
        .set({ revokedAt: now })
        .where(and(eq(tokens.id, id), isNull(tokens.revokedAt))),
      // Not what ends them: a session is checked against its token whenever
      // it is used, so one opened in the same instant ends too. This clears the rows.
      this.db.delete(sessions).where(eq(sessions.openedWith, id)),
    );
  }

  revokeDelegatedToken(uow: UnitOfWork, id: string, now: number): void {
    enlist(uow).add(
      this.db
        .update(delegatedTokens)
        .set({ revokedAt: now })
        .where(and(eq(delegatedTokens.id, id), isNull(delegatedTokens.revokedAt))),
    );
  }

  addDelegatedToken(uow: UnitOfWork, token: DelegatedToken): void {
    enlist(uow).add(
      this.db.insert(delegatedTokens).values({
        ...token,
        can: Object.fromEntries(
          Object.entries(token.can).map(([pattern, permissions]) => [pattern, [...permissions]]),
        ),
      }),
    );
  }

  async findCallerByPrincipal(principal: string): Promise<Caller | null> {
    if (principal.startsWith(SERVICE)) {
      const row = await this.db
        .select({ service: services, teamName: teams.name })
        .from(services)
        .innerJoin(teams, eq(teams.id, services.teamId))
        .where(and(eq(services.id, principal.slice(SERVICE.length)), isNull(services.removedAt)))
        .get();
      return row ? serviceCaller(row) : null;
    }
    if (!principal.startsWith(USER)) return null;
    const row = await this.db
      .select({ user: users, teamName: teams.name })
      .from(users)
      .innerJoin(teams, eq(teams.id, users.teamId))
      .where(eq(users.id, principal.slice(USER.length)))
      .get();
    return row ? toCaller(row) : null;
  }

  async findTeamByName(name: string): Promise<Team | null> {
    return (await this.db.select().from(teams).where(eq(teams.name, name)).get()) ?? null;
  }

  async findUserByHandle(teamId: string, handle: string): Promise<User | null> {
    const row = await this.db
      .select()
      .from(users)
      .where(and(eq(users.teamId, teamId), eq(users.handle, handle)))
      .get();
    return row ?? null;
  }

  async findUsersByPrincipal(teamId: string, principals: readonly string[]): Promise<User[]> {
    const ids = principals
      .filter((principal) => principal.startsWith(USER))
      .map((principal) => principal.slice(USER.length));
    const found: User[] = [];
    for (let from = 0; from < ids.length; from += IDS_PER_STATEMENT) {
      const batch = ids.slice(from, from + IDS_PER_STATEMENT);
      found.push(
        ...(await this.db
          .select()
          .from(users)
          .where(and(eq(users.teamId, teamId), inArray(users.id, batch)))),
      );
    }
    return found;
  }

  async countUsers(teamId: string): Promise<number> {
    const row = await this.db
      .select({ n: count() })
      .from(users)
      .where(eq(users.teamId, teamId))
      .get();
    return row?.n ?? 0;
  }

  async findUserByGitHubId(teamId: string, githubId: number): Promise<User | null> {
    const row = await this.db
      .select()
      .from(users)
      .where(and(eq(users.teamId, teamId), eq(users.githubId, githubId)))
      .get();
    return row ?? null;
  }

  async findUserByGitHubLogin(teamId: string, login: string): Promise<User | null> {
    const row = await this.db
      .select()
      .from(users)
      .where(and(eq(users.teamId, teamId), eq(users.githubLogin, login)))
      .get();
    return row ?? null;
  }

  async findUserAwaitingGitHub(teamId: string, login: string): Promise<User | null> {
    const row = await this.db
      .select()
      .from(users)
      .where(and(eq(users.teamId, teamId), eq(users.githubLogin, login), isNull(users.githubId)))
      .get();
    return row ?? null;
  }

  setGitHub(uow: UnitOfWork, userId: string, account: { id: number | null; login: string }): void {
    enlist(uow).add(
      this.db
        .update(users)
        .set({ githubId: account.id, githubLogin: account.login })
        .where(eq(users.id, userId)),
    );
  }

  async findServiceByName(
    teamId: string,
    name: string,
    removedToo = false,
  ): Promise<Service | null> {
    const row = await this.db
      .select()
      .from(services)
      .where(
        and(
          eq(services.teamId, teamId),
          eq(services.name, name),
          removedToo ? undefined : isNull(services.removedAt),
        ),
      )
      .get();
    return row ?? null;
  }

  async findServicesByPrincipal(teamId: string, principals: readonly string[]): Promise<Service[]> {
    const ids = principals
      .filter((principal) => principal.startsWith(SERVICE))
      .map((principal) => principal.slice(SERVICE.length));
    const found: Service[] = [];
    for (let from = 0; from < ids.length; from += IDS_PER_STATEMENT) {
      const batch = ids.slice(from, from + IDS_PER_STATEMENT);
      found.push(
        ...(await this.db
          .select()
          .from(services)
          .where(and(eq(services.teamId, teamId), inArray(services.id, batch)))),
      );
    }
    return found;
  }

  async listServices(teamId: string): Promise<Service[]> {
    return this.db
      .select()
      .from(services)
      .where(and(eq(services.teamId, teamId), isNull(services.removedAt)))
      .orderBy(asc(services.name));
  }

  addTeam(uow: UnitOfWork, team: Team): void {
    enlist(uow).add(this.db.insert(teams).values(team));
  }

  addUser(uow: UnitOfWork, user: User): void {
    const principal = principalId("user", user.id);
    enlist(uow).add(
      this.db.insert(users).values(user),
      this.db.insert(actors).values({
        id: principal,
        teamId: user.teamId,
        principal,
        profile: null,
        handle: user.handle,
        name: user.name,
        createdAt: user.createdAt,
      }),
    );
  }

  addService(uow: UnitOfWork, service: Service): void {
    const principal = principalId("service", service.id);
    enlist(uow).add(
      this.db.insert(services).values(service),
      this.db.insert(actors).values({
        id: principal,
        teamId: service.teamId,
        principal,
        profile: null,
        handle: service.name,
        name: service.name,
        createdAt: service.createdAt,
      }),
    );
  }

  removeService(uow: UnitOfWork, service: Service, now: number): void {
    enlist(uow).add(
      this.db.update(services).set({ removedAt: now }).where(eq(services.id, service.id)),
      this.db
        .update(serviceTokens)
        .set({ revokedAt: now })
        .where(and(eq(serviceTokens.serviceId, service.id), isNull(serviceTokens.revokedAt))),
    );
  }

  addSession(uow: UnitOfWork, session: Session): void {
    enlist(uow).add(this.db.insert(sessions).values(session));
  }

  async findCallerBySessionHash(hash: string, now: number): Promise<Caller | null> {
    const row = await this.db
      .select({ user: users, teamName: teams.name, id: sessions.id })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(teams, eq(teams.id, users.teamId))
      .where(and(eq(sessions.hash, hash), liveSession(now)))
      .get();
    return row ? { ...toCaller(row), credential: { kind: "session", id: row.id } } : null;
  }

  async removeSession(hash: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.hash, hash));
  }

  async listSessions(userId: string, now: number): Promise<Session[]> {
    return this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), liveSession(now)))
      .orderBy(asc(sessions.createdAt), STORED);
  }

  async removeSessionById(userId: string, id: string): Promise<boolean> {
    const removed = await this.db
      .delete(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
      .returning({ id: sessions.id });
    return removed.length > 0;
  }

  async pruneSessions(now: number): Promise<number> {
    const removed = await this.db
      .delete(sessions)
      .where(or(lte(sessions.expiresAt, now), sql`not ${openedWithLiveToken}`))
      .returning({ id: sessions.id });
    return removed.length;
  }

  async pruneDelegatedTokens(before: number): Promise<number> {
    const removed = await this.db
      .delete(delegatedTokens)
      .where(lt(delegatedTokens.expiresAt, before))
      .returning({ id: delegatedTokens.id });
    return removed.length;
  }

  addToken(uow: UnitOfWork, kind: PrincipalKind, token: Token): void {
    const { owner, ...row } = token;
    enlist(uow).add(
      kind === "service"
        ? this.db.insert(serviceTokens).values({ ...row, serviceId: owner })
        : this.db.insert(tokens).values({ ...row, userId: owner }),
    );
  }
}

// Rows made in the same millisecond are listed in the order they were stored
// in. An ID can't settle it: past its time, it is random.
const STORED = sql`rowid`;

/**
 * Whether a session was opened with a token that still works, or with none.
 * Written with the tables' own names, so it reads the same in a query on
 * `sessions` and inside one on `delegated_tokens`.
 */
const openedWithLiveToken = sql`(sessions.opened_with is null or exists (
  select 1 from tokens where tokens.id = sessions.opened_with and tokens.revoked_at is null))`;

/** Whether a session works at `now`: it has not run out, and neither has what opened it. */
const liveSession = (now: number): SQL =>
  sql`(${sessions.expiresAt} > ${now} and ${openedWithLiveToken})`;

/**
 * 1 while what a delegated token was minted with still works at `now`, and 0
 * once it doesn't: a person's token or a service's that was revoked, a
 * session that is over. A token minted before this was recorded has nothing
 * to end with but its own time. The parent must be the principal's own: an
 * ID that happened to match a row of someone else's backs nothing.
 *
 * It is decided when the token is used, not when its parent is revoked: a
 * token minted in the same instant as the revocation would otherwise slip by it.
 */
const backed = (now: number): SQL => sql`case
  when delegated_tokens.minted_with is null then 1
  when exists (select 1 from tokens
    where tokens.id = delegated_tokens.minted_with and tokens.revoked_at is null
      and delegated_tokens.principal = 'vibe:user:' || tokens.user_id) then 1
  when exists (select 1 from service_tokens
    where service_tokens.id = delegated_tokens.minted_with
      and service_tokens.revoked_at is null
      and delegated_tokens.principal = 'vibe:service:' || service_tokens.service_id) then 1
  when exists (select 1 from sessions
    where sessions.id = delegated_tokens.minted_with
      and sessions.expires_at > ${now} and ${openedWithLiveToken}
      and delegated_tokens.principal = 'vibe:user:' || sessions.user_id) then 1
  else 0 end`;

/** A person acting as themselves, from their row and their team's name. */
function toCaller(row: { user: User; teamName: string }): Caller {
  const principal = principalId("user", row.user.id);
  return {
    actorId: principal,
    principal,
    profile: null,
    teamId: row.user.teamId,
    teamName: row.teamName,
    handle: row.user.handle,
    name: row.user.name,
    role: row.user.role,
    narrowed: null,
    credential: null,
  };
}

/** A service acting as itself. Its role is `service`: its grants alone decide what it can do. */
function serviceCaller(row: { service: Service; teamName: string }): Caller {
  const principal = principalId("service", row.service.id);
  return {
    actorId: principal,
    principal,
    profile: null,
    teamId: row.service.teamId,
    teamName: row.teamName,
    handle: row.service.name,
    name: row.service.name,
    role: "service",
    narrowed: null,
    credential: null,
  };
}

export class DrizzleActorDirectory implements ActorDirectory {
  constructor(private readonly db: Db) {}

  introduce(uow: UnitOfWork, caller: Caller, now: number): void {
    if (caller.profile === null) return;
    enlist(uow).add(
      this.db
        .insert(actors)
        .values({
          id: caller.actorId,
          teamId: caller.teamId,
          principal: caller.principal,
          profile: caller.profile,
          handle: caller.handle,
          name: caller.name,
          createdAt: now,
        })
        // An actor that is already there is left as it is. A handle that
        // someone else has is not passed over: the write fails, rather than
        // leave a message whose author nobody can look up.
        .onConflictDoNothing({ target: actors.id }),
    );
  }
}

export class DrizzleGrantRepository implements GrantRepository {
  constructor(private readonly db: Db) {}

  /**
   * One statement reads the grants in force, the last one made, revoked or
   * not, and the policy's revision, so all three are of the same instant and a
   * request pays for the grants that count, however many a vibe has gone through.
   */
  async current(vibeId: string): Promise<StoredGrants> {
    const rows = await this.db
      .select({
        grant: grants,
        revision: sql<number | null>`(
          SELECT max(made.revision) FROM policy_revisions made WHERE made.vibe_id = ${vibeId})`,
      })
      .from(grants)
      .where(
        and(
          eq(grants.vibeId, vibeId),
          or(
            isNull(grants.revokedAt),
            sql`${grants.n} = (SELECT max(made.n) FROM grants made WHERE made.vibe_id = ${vibeId})`,
          ),
        ),
      )
      .orderBy(asc(grants.n));
    const last = rows[rows.length - 1];
    return {
      last: last?.grant.n ?? 0,
      revision: last?.revision ?? 0,
      grants: rows
        .filter((row) => row.grant.revokedAt === null)
        .map(({ grant }) => ({
          n: grant.n,
          principals: grant.principals as GrantPrincipal[],
          can: grant.can as Can,
          createdBy: grant.createdBy,
          createdAt: grant.createdAt,
          revokedAt: grant.revokedAt,
        })),
    };
  }

  add(uow: UnitOfWork, vibeId: string, grant: StoredGrant): void {
    enlist(uow).add(this.db.insert(grants).values({ vibeId, ...toRow(grant) }));
  }

  update(uow: UnitOfWork, vibeId: string, grant: StoredGrant): void {
    const { principals, can, revokedAt } = toRow(grant);
    enlist(uow).add(
      this.db
        .update(grants)
        .set({ principals, can, revokedAt })
        .where(and(eq(grants.vibeId, vibeId), eq(grants.n, grant.n))),
    );
  }

  advance(uow: UnitOfWork, vibeId: string, revision: number): void {
    enlist(uow).add(this.db.insert(policyRevisions).values({ vibeId, revision: revision + 1 }));
  }

  lostRace(error: unknown): boolean {
    return (
      error instanceof ConstraintViolation && (error.on("grants") || error.on("policy_revisions"))
    );
  }
}

function toRow(grant: StoredGrant) {
  return {
    n: grant.n,
    principals: [...grant.principals],
    can: Object.fromEntries(
      Object.entries(grant.can).map(([pattern, permissions]) => [pattern, [...permissions]]),
    ),
    createdBy: grant.createdBy,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
  };
}
