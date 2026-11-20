import { invalid } from "@vibe/kernel";

/** Who GitHub says has signed in. */
export interface GitHubAccount {
  /** The account's number. It stays the same when the account is renamed. */
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly email: string | null;
}

const LOGIN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

/**
 * A GitHub login, lowercase: up to 39 letters, numbers and single hyphens.
 * It is spelled exactly as a handle is, which is why a person who signs up
 * through GitHub gets their login as their handle.
 */
export function parseGitHubLogin(input: string): string {
  const login = input.replace(/^@/, "").toLowerCase();
  if (!LOGIN.test(login)) {
    throw invalid(
      "invalid_github_login",
      `"${input}" is not a GitHub login.`,
      "Use the name in the account's URL, such as octocat for github.com/octocat.",
    );
  }
  return login;
}
