import {
  type BeginUnitOfWork,
  type Clock,
  conflict,
  ConstraintViolation,
  forbidden,
  invalid,
  newId,
  notFound,
  profileActorId,
  unauthorized,
} from "@vibe/kernel";

import type { Caller } from "../domain/caller.ts";
import { parseGitHubLogin } from "../domain/github.ts";
import { parseHandle } from "../domain/handle.ts";
import { narrow, parseLimits } from "../domain/narrowing.ts";
import { parseProfile, profileHandle } from "../domain/profile.ts";
import type { PersonRole } from "../domain/role.ts";
import { hashToken, tokenKind } from "../domain/token.ts";
import type { IdentityRepository, Team, User } from "./ports.ts";
import { mintToken } from "./tokens.ts";

/** The team a deployment uses until tenancy is settled: one organisation per deployment. */
export const DEFAULT_TEAM = "default";

export interface CreateUser {
  handle: string;
  name?: string | undefined;
  email?: string | undefined;
  role?: PersonRole | undefined;
  team?: string | undefined;
  /** The login of the GitHub account they will sign in with. */
  github?: string | undefined;
}

export interface CreatedUser {
  user: User;
  /** The secret, returned this once. */
  token: string;
}

export class IdentityService {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Turns a bearer token into the caller it belongs to.
   *
   * @param profile The name the caller writes under, when it names one. The
   *   caller keeps its principal's access and gets an actor of its own.
   * @param limits What the request asks to be held to, as the JSON of a map
   *   from channel pattern to permissions, or of a list of them. It only ever
   *   takes access away.
   */
  async authenticate(
    token: string | null,
    profile?: string | null,
    limits?: string | null,
  ): Promise<Caller> {
    if (!token) {
      throw unauthorized(
        "unauthorized",
        "This request carries no token.",
        "Set VIBE_TOKEN, or run `vibe login`.",
      );
    }
    const kind = tokenKind(token);
    let caller: Caller | null = null;
    if (kind === "delegated") caller = await this.delegated(await hashToken(token), profile);
    else if (kind !== null) {
      const holder = await this.repository.findCallerByTokenHash(kind, await hashToken(token));
      caller = holder && writingAs(holder, profile);
    }
    if (!caller) {
      throw unauthorized(
        "unauthorized",
        "This token is unknown or revoked.",
        "Ask a team owner for a new one.",
      );
    }
    return held(caller, limits);
  }

  /**
   * A caller who was recognised some other way than by a token, such as by a
   * browser's session, under the profile and the limits their request names.
   */
  acting(caller: Caller, profile?: string | null, limits?: string | null): Caller {
    return held(writingAs(caller, profile), limits);
  }

  /**
   * The caller behind a delegated token: its principal as it is now, writing
   * as the token's one profile, held to the token's limit.
   */
  private async delegated(hash: string, profile?: string | null): Promise<Caller | null> {
    const now = this.clock.now();
    const token = await this.repository.findDelegatedToken(hash, now);
    // Revoked by name, or minted with something that has stopped working.
    if (!token || token.revokedAt !== null || !token.backed) return null;
    if (token.expiresAt <= now) {
      throw unauthorized(
        "unauthorized",
        "This token has expired.",
        "Mint another with `vibe token create`, using the token it was minted from.",
      );
    }
    if (profile != null && profile.trim() !== "" && parseProfile(profile) !== token.profile) {
      throw forbidden(
        "profile_locked",
        `This token writes as ${token.profile}, and as no one else.`,
        "Leave the profile out, or mint a token for the other profile.",
      );
    }
    const holder = await this.repository.findCallerByPrincipal(token.principal);
    if (!holder) return null;
    return narrow(
      { ...writingAs(holder, token.profile), credential: { kind: "delegated", id: token.id } },
      { vibeId: token.vibeId, can: token.can, expiresAt: token.expiresAt },
    );
  }

  /**
   * A principal as it stands now, for work done on its behalf with nobody
   * there to show a credential, such as a scheduled post. It has the role and
   * the grants the principal has now, not those it had when the work was set up.
   *
   * @returns `null` when the principal is gone.
   */
  async callerOf(principal: string, profile: string | null): Promise<Caller | null> {
    const caller = await this.repository.findCallerByPrincipal(principal);
    return caller && writingAs(caller, profile);
  }

  /** An operator's action: adds a person and mints their first token. The first person on a team owns it. */
  async createUser(input: CreateUser): Promise<CreatedUser> {
    const { repository, begin, clock } = this;
    const handle = parseHandle(input.handle);
    const githubLogin = input.github === undefined ? null : parseGitHubLogin(input.github);
    const now = clock.now();
    const uow = begin();

    const teamName = (input.team ?? DEFAULT_TEAM).toLowerCase();
    let team: Team | null = await repository.findTeamByName(teamName);
    let firstOnTeam = false;
    if (team) {
      if (await repository.findUserByHandle(team.id, handle)) throw handleTaken(handle);
      if (githubLogin !== null) await this.requireFree(team.id, githubLogin, null);
      firstOnTeam = (await repository.countUsers(team.id)) === 0;
    } else {
      team = { id: newId("team", now), name: teamName, createdAt: now };
      repository.addTeam(uow, team);
      firstOnTeam = true;
    }

    const user: User = {
      id: newId("u", now),
      teamId: team.id,
      handle,
      name: input.name ?? handle,
      email: input.email ?? null,
      role: input.role ?? (firstOnTeam ? "owner" : "member"),
      createdAt: now,
      githubId: null,
      githubLogin,
    };
    repository.addUser(uow, user);
    const token = await mintToken(repository, uow, "user", user.id, "initial", now);

    try {
      await uow.commit();
    } catch (error) {
      // Someone created the same team or handle between our read and our write.
      if (error instanceof ConstraintViolation) throw handleTaken(handle);
      throw error;
    }
    return { user, token };
  }

  /**
   * An operator's action: says which GitHub account a person signs in with.
   * It takes effect at their next sign-in, and replaces any account they
   * signed in with before.
   */
  async linkGitHub(input: { handle: string; github: string; team?: string }): Promise<User> {
    const { repository, begin } = this;
    const handle = parseHandle(input.handle);
    const login = parseGitHubLogin(input.github);
    const team = await repository.findTeamByName((input.team ?? DEFAULT_TEAM).toLowerCase());
    const user = team && (await repository.findUserByHandle(team.id, handle));
    if (!user) throw notFound("user_not_found", `No one on this team has the handle ${handle}.`);
    await this.requireFree(user.teamId, login, user.id);

    const uow = begin();
    repository.setGitHub(uow, user.id, { id: null, login });
    await uow.commit();
    return { ...user, githubId: null, githubLogin: login };
  }

  /**
   * Refuses a GitHub login that is on record for someone else. Two people
   * can't be named for one account: which of them signed in would be chance.
   */
  private async requireFree(teamId: string, login: string, forUser: string | null): Promise<void> {
    const holder = await this.repository.findUserByGitHubLogin(teamId, login);
    if (!holder || holder.id === forUser) return;
    throw conflict(
      "github_taken",
      `The GitHub account ${login} is already ${holder.handle}'s.`,
      `To move it, link ${holder.handle} to another account first: vibe admin user link ${holder.handle} --github <LOGIN>`,
    );
  }

  /** Mints another token for someone already on the team. */
  async mintToken(input: { handle: string; label?: string; team?: string }): Promise<string> {
    const { repository, begin, clock } = this;
    const handle = parseHandle(input.handle);
    const team = await repository.findTeamByName((input.team ?? DEFAULT_TEAM).toLowerCase());
    const user = team && (await repository.findUserByHandle(team.id, handle));
    if (!user) throw notFound("user_not_found", `No one on this team has the handle ${handle}.`);

    const uow = begin();
    const token = await mintToken(
      repository,
      uow,
      "user",
      user.id,
      input.label ?? null,
      clock.now(),
    );
    await uow.commit();
    return token;
  }
}

/** The caller, held to the limits its request asks for, when it asks for any. */
function held(caller: Caller, limits: string | null | undefined): Caller {
  if (limits === undefined || limits === null || limits.trim() === "") return caller;
  return asked(limits).reduce(
    (narrowed, can) => narrow(narrowed, { vibeId: null, can, expiresAt: null }),
    caller,
  );
}

/** The limits a request carries, read from its header. */
function asked(limits: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(limits);
  } catch {
    throw invalid(
      "invalid_can",
      "The Vibe-Can header is not JSON.",
      `Send a map from channel pattern to permissions, such as {"dev/":["read","post"]}.`,
    );
  }
  return parseLimits(parsed);
}

/** The caller under the profile it names, or as itself when it names none. */
export function writingAs(caller: Caller, profile: string | null | undefined): Caller {
  if (profile === undefined || profile === null || profile.trim() === "") return caller;
  const name = parseProfile(profile);
  return {
    ...caller,
    actorId: profileActorId(caller.principal, name),
    profile: name,
    handle: profileHandle(caller.handle, name),
    name,
  };
}

export function handleTaken(handle: string) {
  return conflict(
    "handle_taken",
    `The handle ${handle} is taken.`,
    "Pick another handle, or mint a token for the existing user.",
  );
}
