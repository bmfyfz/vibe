import { type BeginUnitOfWork, type Clock, systemClock } from "@vibe/kernel";
import type { Db } from "@vibe/store";

import { Attempts } from "./application/attempts.ts";
import { type Authorizer, GrantAuthorizer } from "./application/authorizer.ts";
import { Delegation } from "./application/delegation.ts";
import { Grants } from "./application/grants.ts";
import { HeldTokens } from "./application/held-tokens.ts";
import { IdentityService } from "./application/identity-service.ts";
import type { ActorDirectory } from "./application/ports.ts";
import { Services } from "./application/services.ts";
import { Sessions } from "./application/sessions.ts";
import { SignIn } from "./application/sign-in.ts";
import { Upkeep } from "./application/upkeep.ts";
import { DrizzleAttemptRepository } from "./infrastructure/drizzle-attempts.ts";
import {
  DrizzleActorDirectory,
  DrizzleGrantRepository,
  DrizzleIdentityRepository,
} from "./infrastructure/drizzle-identity-repository.ts";
import { type Fetch, GitHubDeviceFlow } from "./infrastructure/github-device-flow.ts";

export type { Authorizer, Resource } from "./application/authorizer.ts";
export type {
  Explanation,
  Grants,
  GrantView,
  PrincipalInput,
  PrincipalView,
} from "./application/grants.ts";
export type { Delegation, MintDelegatedToken, MintedToken } from "./application/delegation.ts";
export type { CreatedUser, CreateUser } from "./application/identity-service.ts";
export { DEFAULT_TEAM, IdentityService } from "./application/identity-service.ts";
export type { ActorDirectory, Service, Team, User } from "./application/ports.ts";
export type { CreatedService, Services } from "./application/services.ts";
export type { OpenedSession, Sessions, SessionView } from "./application/sessions.ts";
export { SESSION_TTL_MS } from "./domain/session.ts";
export type { Attempts, Taken } from "./application/attempts.ts";
export type { HeldTokens, TokenView } from "./application/held-tokens.ts";
export type { Cleared, Upkeep } from "./application/upkeep.ts";
export {
  addressKey,
  type Budget,
  OPERATOR_SECRET,
  REFUSED_CREDENTIALS,
  REFUSED_WEBHOOKS,
  SIGN_IN_ASKS,
  SIGN_INS_STARTED,
} from "./domain/attempts.ts";
export type {
  DeviceAuthorizer,
  DeviceCheck,
  DeviceCode,
  SignIn,
  SignInResult,
} from "./application/sign-in.ts";
export type { GitHubAccount } from "./domain/github.ts";
export type { Caller, Credential } from "./domain/caller.ts";
export { parseHandle } from "./domain/handle.ts";
export {
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
  type Narrowing,
  refuseNarrowed,
} from "./domain/narrowing.ts";
export { parseProfile } from "./domain/profile.ts";
export { Access, AccessPolicy, type Decision, type Subject } from "./domain/access-policy.ts";
export { type Can, DEFAULT_GRANTS, type Grant, type GrantPrincipal } from "./domain/grant.ts";
export type { Permission, PersonRole, Role } from "./domain/role.ts";
export { PERMISSIONS, roleAllows } from "./domain/role.ts";

export interface Identity {
  service: IdentityService;
  /** The team's machine principals. */
  services: Services;
  /** Tokens that pass on part of a caller's access. */
  delegation: Delegation;
  /** Signing in as a person, through GitHub. */
  signIn: SignIn;
  /** People signed in from a browser. */
  sessions: Sessions;
  /** Which tokens a principal has, and revoking one. */
  tokens: HeldTokens;
  /** What bounds how often a credential can be guessed, or a sign-in started, from one place. */
  attempts: Attempts;
  /** Clears away sessions, tokens and counts that are over. */
  upkeep: Upkeep;
  authorizer: Authorizer;
  actors: ActorDirectory;
  grants: Grants;
}

/** Wires the Identity & Access context to a database. */
export function createIdentity(deps: {
  db: Db;
  begin: BeginUnitOfWork;
  clock?: Clock | undefined;
  /**
   * The GitHub OAuth app people sign in through. Left out, there is no
   * sign-in but a token someone hands you.
   */
  github?:
    | {
        clientId: string;
        /** Whether a GitHub account that is no one's here may join as a new member. */
        allowSignup?: boolean | undefined;
        /** How GitHub is reached. `fetch`, when left out. */
        fetch?: Fetch | undefined;
      }
    | undefined;
}): Identity {
  const clock = deps.clock ?? systemClock;
  const identities = new DrizzleIdentityRepository(deps.db);
  const grants = new DrizzleGrantRepository(deps.db);
  const attempts = new Attempts(new DrizzleAttemptRepository(deps.db), clock);
  return {
    service: new IdentityService(identities, deps.begin, clock),
    services: new Services(identities, deps.begin, clock),
    delegation: new Delegation(identities, grants, deps.begin, clock),
    signIn: new SignIn(
      identities,
      deps.begin,
      clock,
      deps.github
        ? new GitHubDeviceFlow(
            deps.github.clientId,
            deps.github.fetch ?? ((url, init) => fetch(url, init)),
          )
        : null,
      deps.github?.allowSignup === true,
    ),
    sessions: new Sessions(identities, deps.begin, clock),
    tokens: new HeldTokens(identities, deps.begin, clock),
    attempts,
    upkeep: new Upkeep(identities, attempts, clock),
    authorizer: new GrantAuthorizer(grants),
    actors: new DrizzleActorDirectory(deps.db),
    grants: new Grants(grants, identities, deps.begin, clock),
  };
}
