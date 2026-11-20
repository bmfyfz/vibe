import {
  type BeginUnitOfWork,
  type Clock,
  conflict,
  ConstraintViolation,
  forbidden,
  invalid,
  newId,
  notFound,
  unavailable,
  type UnitOfWork,
} from "@vibe/kernel";

import type { GitHubAccount } from "../domain/github.ts";
import { parseGitHubLogin } from "../domain/github.ts";
import { DEFAULT_TEAM } from "./identity-service.ts";
import type { IdentityRepository, Team, User } from "./ports.ts";
import type { OpenedSession, Sessions } from "./sessions.ts";
import { mintToken } from "./tokens.ts";

/** What a device shows its user: a code to enter on a page, in a browser, anywhere. */
export interface DeviceCode {
  /** What the device shows GitHub to ask whether the user has approved. Kept by the device. */
  deviceCode: string;
  /** What the user types in. */
  userCode: string;
  /** Where they type it. */
  verificationUri: string;
  /** How long the codes last, in seconds. */
  expiresIn: number;
  /** How long to leave between asking, in seconds. */
  interval: number;
}

/** What became of a device's request to sign in. */
export type DeviceCheck =
  | { status: "pending"; interval: number | null }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "authorized"; account: GitHubAccount };

/** GitHub's device flow, as signing in needs it. */
export interface DeviceAuthorizer {
  begin(): Promise<DeviceCode>;
  check(deviceCode: string): Promise<DeviceCheck>;
}

export type SignInResult =
  | { status: "pending"; interval: number | null }
  | { status: "complete"; user: User; token: string; created: boolean };

/** A sign-in from a browser: the same, with a session in place of a token. */
export type BrowserSignInResult =
  | { status: "pending"; interval: number | null }
  | { status: "complete"; user: User; session: OpenedSession; created: boolean };

/** What a person who has signed in is given to go on with, written in the commit that admits them. */
type Credential<Given> = (uow: UnitOfWork, user: User, now: number) => Promise<Given>;

/**
 * Signing in as a person, through GitHub's device flow: the device shows a
 * code, the person approves it in a browser, and Vibe then knows which GitHub
 * account is asking. Vibe issues a token of its own for the person that
 * account belongs to, and keeps nothing of GitHub's.
 */
export class SignIn {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
    /** `null` on a Vibe that has no GitHub app to sign in through. */
    private readonly github: DeviceAuthorizer | null,
    /** Whether a GitHub account no one here is linked to may join as a new member. */
    private readonly allowSignup: boolean,
  ) {}

  /** Whether this Vibe has a GitHub app to sign in through. */
  get available(): boolean {
    return this.github !== null;
  }

  /** Starts a sign-in, and returns the code for the person to approve. */
  start(): Promise<DeviceCode> {
    return this.authorizer().begin();
  }

  /**
   * Finishes a sign-in once the person has approved it.
   *
   * @returns `pending` while they haven't, or the person and a new token of theirs.
   * @throws `login_denied` when they said no, `login_expired` when the code
   *   ran out, and `signup_closed` when the account is no one's here.
   */
  async finish(deviceCode: string): Promise<SignInResult> {
    const result = await this.settle(deviceCode, (uow, user, now) =>
      mintToken(this.repository, uow, "user", user.id, "login", now),
    );
    if (result.status === "pending") return result;
    const { given: token, ...rest } = result;
    return { ...rest, token };
  }

  /**
   * Finishes a sign-in that a browser started. The person gets a session, and
   * no token is minted: there is nowhere in a browser to keep one safely.
   */
  async finishInBrowser(
    deviceCode: string,
    sessions: Sessions,
    userAgent?: string | null,
  ): Promise<BrowserSignInResult> {
    const result = await this.settle(deviceCode, (uow, user) =>
      sessions.open(uow, user.id, { userAgent }),
    );
    if (result.status === "pending") return result;
    const { given: session, ...rest } = result;
    return { ...rest, session };
  }

  private async settle<Given>(
    deviceCode: string,
    credential: Credential<Given>,
  ): Promise<
    | { status: "pending"; interval: number | null }
    | { status: "complete"; user: User; given: Given; created: boolean }
  > {
    const check = await this.authorizer().check(deviceCode);
    if (check.status === "pending") return check;
    if (check.status === "denied") {
      throw forbidden("login_denied", "The sign-in was refused in the browser.");
    }
    if (check.status === "expired") {
      throw invalid(
        "login_expired",
        "This sign-in ran out, or was never started.",
        "Run `vibe login <url>` again.",
      );
    }
    return { status: "complete", ...(await this.admit(check.account, credential)) };
  }

  /**
   * The person a GitHub account belongs to, with a new credential for them. They
   * are whoever signed in with the account before, by its number. Failing
   * that, whoever an operator said the account's login belongs to. Failing
   * that, a new member, where the operator allows it.
   */
  private async admit<Given>(
    account: GitHubAccount,
    credential: Credential<Given>,
  ): Promise<{ user: User; given: Given; created: boolean }> {
    const { repository, begin, clock } = this;
    const login = parseGitHubLogin(account.login);
    const now = clock.now();
    const uow = begin();

    let team: Team | null = await repository.findTeamByName(DEFAULT_TEAM);
    let user =
      team &&
      ((await repository.findUserByGitHubId(team.id, account.id)) ??
        (await repository.findUserAwaitingGitHub(team.id, login)));
    const created = !user;
    if (user) {
      // Their first sign-in records the account's number. A later one, its login as it is now.
      if (user.githubId !== account.id || user.githubLogin !== login) {
        repository.setGitHub(uow, user.id, { id: account.id, login });
      }
    } else {
      if (!this.allowSignup) {
        throw forbidden(
          "signup_closed",
          `No one on this Vibe signs in as the GitHub account ${login}.`,
          `Ask its operator to add you: vibe admin user create <handle> --github ${login}`,
        );
      }
      let firstOnTeam = false;
      if (team) {
        if (await repository.findUserByHandle(team.id, login)) throw taken(login);
        firstOnTeam = (await repository.countUsers(team.id)) === 0;
      } else {
        team = { id: newId("team", now), name: DEFAULT_TEAM, createdAt: now };
        repository.addTeam(uow, team);
        firstOnTeam = true;
      }
      user = {
        id: newId("u", now),
        teamId: team.id,
        // A GitHub login is spelled as a handle is.
        handle: login,
        name: account.name?.trim() || login,
        email: account.email,
        role: firstOnTeam ? "owner" : "member",
        createdAt: now,
        githubId: account.id,
        githubLogin: login,
      };
      repository.addUser(uow, user);
    }

    const given = await credential(uow, user, now);
    try {
      await uow.commit();
    } catch (error) {
      // Someone took the handle, or signed in with the same account, just now.
      if (error instanceof ConstraintViolation) throw taken(login);
      throw error;
    }
    return { user: { ...user, githubId: account.id, githubLogin: login }, given, created };
  }

  private authorizer(): DeviceAuthorizer {
    if (this.github) return this.github;
    throw notFound(
      "login_unavailable",
      "This Vibe has no GitHub sign-in.",
      "Log in with a token: vibe login <url> --token <TOKEN>. Its operator can add GitHub sign-in by setting VIBE_GITHUB_CLIENT_ID.",
    );
  }
}

const taken = (login: string) =>
  conflict(
    "handle_taken",
    `Someone on this Vibe already has the handle ${login}, and it isn't linked to your GitHub account.`,
    `If that is you, ask the operator to link it: vibe admin user link ${login} --github ${login}`,
  );

/** GitHub answered with something that isn't an answer. Nothing of the sign-in is decided. */
export const githubUnavailable = (what: string) =>
  unavailable(
    "github_unavailable",
    `GitHub could not be asked: ${what}`,
    "Try again in a moment. If it keeps failing, check the Vibe's VIBE_GITHUB_CLIENT_ID.",
  );
