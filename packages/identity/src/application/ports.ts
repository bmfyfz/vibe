import type { PrincipalKind, UnitOfWork } from "@vibe/kernel";

import type { Caller } from "../domain/caller.ts";
import type { Can, Grant } from "../domain/grant.ts";
import type { PersonRole } from "../domain/role.ts";
import type { TokenKind } from "../domain/token.ts";

export interface Team {
  id: string;
  name: string;
  createdAt: number;
}

export interface User {
  id: string;
  teamId: string;
  handle: string;
  name: string;
  email: string | null;
  role: PersonRole;
  createdAt: number;
  /** The number of the GitHub account they sign in with, once they have. */
  githubId: number | null;
  /** That account's login. Before the first sign-in, the account an operator said is theirs. */
  githubLogin: string | null;
}

/** A machine principal: a CI job, a worker, anything that acts with no person behind it. */
export interface Service {
  id: string;
  teamId: string;
  /** Its handle, unique on the team among people and services alike. */
  name: string;
  description: string | null;
  /** The actor that created it. */
  createdBy: string;
  createdAt: number;
  /** Set once it is removed. */
  removedAt: number | null;
}

/** A token of a person or of a service: `owner` is the ID of whichever it is. */
export interface Token {
  id: string;
  hash: string;
  owner: string;
  label: string | null;
  createdAt: number;
  /** Set once it is revoked. */
  revokedAt: number | null;
}

/** A token minted from a principal's own, for one vibe and one profile, with less access and an end. */
export interface DelegatedToken {
  id: string;
  hash: string;
  /** Whose access it narrows. */
  principal: string;
  vibeId: string;
  profile: string;
  can: Can;
  /** The actor that minted it. */
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  /**
   * The ID of the token or the session its minter was recognised by. The
   * token works only while that does. `null` for one minted before this was
   * recorded.
   */
  mintedWith: string | null;
  /** Set once it is revoked by name. */
  revokedAt: number | null;
}

/** A person signed in from a browser. */
export interface Session {
  id: string;
  /** SHA-256 of the secret the browser holds. */
  hash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  /** The ID of the token it was opened with, and ends with. `null` when it was opened through GitHub. */
  openedWith: string | null;
  /** What the browser called itself when it signed in. */
  userAgent: string | null;
}

export interface IdentityRepository {
  /** Whoever a token of this kind belongs to. `null` for one that is unknown, revoked, or a removed service's. */
  findCallerByTokenHash(kind: PrincipalKind, hash: string): Promise<Caller | null>;
  /**
   * A delegated token by its hash, expired or revoked or not, and whether
   * what minted it still works at `now`: a token that isn't revoked, or a
   * session that is neither over nor opened with a token since revoked.
   */
  findDelegatedToken(hash: string, now: number): Promise<BackedDelegatedToken | null>;
  addDelegatedToken(uow: UnitOfWork, token: DelegatedToken): void;
  /** A principal's own tokens that work, oldest first. */
  listTokens(kind: PrincipalKind, owner: string): Promise<Token[]>;
  /** The delegated tokens minted from a principal that work at `now`, oldest first. */
  listDelegatedTokens(principal: string, now: number): Promise<DelegatedToken[]>;
  /** One of a principal's own tokens by its ID, revoked or not. */
  findToken(kind: PrincipalKind, owner: string, id: string): Promise<Token | null>;
  /** A delegated token minted from a principal, by its ID, whatever became of it. */
  findDelegatedTokenById(principal: string, id: string): Promise<DelegatedToken | null>;
  /**
   * Revokes a principal's own token. Whatever was minted with it, and any
   * session it opened, stops working with it: each is checked against it
   * when it is used. The sessions are removed here as well.
   */
  revokeToken(uow: UnitOfWork, kind: PrincipalKind, id: string, now: number): void;
  revokeDelegatedToken(uow: UnitOfWork, id: string, now: number): void;
  /** A principal as it is now, with the role it has now. `null` when there is no such principal. */
  findCallerByPrincipal(principal: string): Promise<Caller | null>;
  findTeamByName(name: string): Promise<Team | null>;
  findUserByHandle(teamId: string, handle: string): Promise<User | null>;
  /** The people behind principal IDs, such as `vibe:user:u_…`. Unknown ones are left out. */
  findUsersByPrincipal(teamId: string, principals: readonly string[]): Promise<User[]>;
  countUsers(teamId: string): Promise<number>;
  /** Whoever signs in with a GitHub account, by the account's number. */
  findUserByGitHubId(teamId: string, githubId: number): Promise<User | null>;
  /** Whoever is on record under a GitHub login, signed in with it or only named for it. */
  findUserByGitHubLogin(teamId: string, login: string): Promise<User | null>;
  /** Whoever an operator said a GitHub login belongs to, and who has not signed in with it yet. */
  findUserAwaitingGitHub(teamId: string, login: string): Promise<User | null>;
  /** Records which GitHub account a person signs in with. `id` is `null` until they first do. */
  setGitHub(uow: UnitOfWork, userId: string, account: { id: number | null; login: string }): void;
  /** A service by its name. One that was removed is found only when asked for. */
  findServiceByName(teamId: string, name: string, removedToo?: boolean): Promise<Service | null>;
  /** The services behind principal IDs, such as `vibe:service:s_…`, removed ones included. */
  findServicesByPrincipal(teamId: string, principals: readonly string[]): Promise<Service[]>;
  /** The team's services, by name. Removed ones are left out. */
  listServices(teamId: string): Promise<Service[]>;
  addTeam(uow: UnitOfWork, team: Team): void;
  /** Adds the user and the actor that represents them. */
  addUser(uow: UnitOfWork, user: User): void;
  /** Adds the service and the actor that represents it. */
  addService(uow: UnitOfWork, service: Service): void;
  /** Marks a service removed and revokes its tokens. Its actor stays: what it wrote is still its own. */
  removeService(uow: UnitOfWork, service: Service, now: number): void;
  addToken(uow: UnitOfWork, kind: Exclude<TokenKind, "delegated">, token: Token): void;
  addSession(uow: UnitOfWork, session: Session): void;
  /**
   * Whoever a session belongs to, as they are now. `null` for one that is
   * unknown, over, or was opened with a token that has since been revoked.
   */
  findCallerBySessionHash(hash: string, now: number): Promise<Caller | null>;
  removeSession(hash: string): Promise<void>;
  /** A person's sessions that work at `now`, oldest first. */
  listSessions(userId: string, now: number): Promise<Session[]>;
  /**
   * Ends one of a person's sessions, by its ID.
   *
   * @returns Whether there was one to end.
   */
  removeSessionById(userId: string, id: string): Promise<boolean>;
  /**
   * Removes the sessions that are over at `now`, and those opened with a
   * token that was revoked. None of them works: this only clears the rows.
   *
   * @returns How many went.
   */
  pruneSessions(now: number): Promise<number>;
  /**
   * Removes the delegated tokens that ended before `before`.
   *
   * @returns How many went.
   */
  pruneDelegatedTokens(before: number): Promise<number>;
}

/** A delegated token, with whether what minted it still works. */
export interface BackedDelegatedToken extends DelegatedToken {
  /** `false` once the token or the session it was minted with has stopped working. */
  backed: boolean;
}

/** Where actors become known to the vibe. */
export interface ActorDirectory {
  /**
   * Adds the caller's actor to a unit of work unless it's already known. A
   * principal's actor exists from the start; a profile's first write introduces it.
   */
  introduce(uow: UnitOfWork, caller: Caller, now: number): void;
}

export interface StoredGrant extends Grant {
  readonly createdBy: string;
  readonly createdAt: number;
  /** Set once the grant is revoked. It keeps its number, and gives nothing. */
  readonly revokedAt: number | null;
}

/** A vibe's grants as they stand. */
export interface StoredGrants {
  /** The grants in force. Revoked ones are left out. */
  readonly grants: readonly StoredGrant[];
  /**
   * The highest number the vibe has handed out, revoked grants included. 0 for
   * a vibe whose grants nobody has changed: the defaults govern it.
   */
  readonly last: number;
  /** Counts the changes made to the vibe's grants. The next change must make the next one. */
  readonly revision: number;
}

export interface GrantRepository {
  current(vibeId: string): Promise<StoredGrants>;
  add(uow: UnitOfWork, vibeId: string, grant: StoredGrant): void;
  /** Stores a grant's principals, what it gives, and whether it is revoked. */
  update(uow: UnitOfWork, vibeId: string, grant: StoredGrant): void;
  /**
   * Records that a unit of work changes the grants read at `revision`. Its
   * commit fails as a whole when another change to the vibe's grants landed
   * since, whichever grant that was.
   */
  advance(uow: UnitOfWork, vibeId: string, revision: number): void;
  /** Whether a failed commit lost a race with another change to the vibe's grants. */
  lostRace(error: unknown): boolean;
}
