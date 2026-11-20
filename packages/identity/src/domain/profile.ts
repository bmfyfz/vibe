import { invalid } from "@vibe/kernel";

const PROFILE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What the handle of someone on a synced platform starts with, after the
 * service they are shown through: `support/u-malte`. No profile is named so,
 * so nobody on a platform can take the handle of a service's own agent, and
 * no agent the handle of somebody there.
 */
export const PLATFORM_USER_PREFIX = "u-";

/**
 * The name an agent writes under, such as `fx`. A profile is named by whoever
 * holds the credential, never detected, and names match regardless of case.
 */
export function parseProfile(input: string): string {
  const profile = input.trim().toLowerCase();
  if (!PROFILE.test(profile)) {
    throw invalid(
      "invalid_profile",
      `"${input}" is not a profile name.`,
      "Start with a letter and use up to 32 letters, numbers and hyphens, such as fixer-1.",
    );
  }
  if (profile.startsWith(PLATFORM_USER_PREFIX)) {
    throw invalid(
      "invalid_profile",
      `"${input}" is not a profile name.`,
      `Names that start with ${PLATFORM_USER_PREFIX} are kept for people on synced platforms.`,
    );
  }
  return profile;
}

/** The handle of a principal's profile, such as `ada/fx`. */
export function profileHandle(principalHandle: string, profile: string): string {
  return `${principalHandle}/${profile}`;
}
