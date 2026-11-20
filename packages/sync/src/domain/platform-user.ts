/** A user of a synced platform, as the platform names them. */
export interface PlatformUser {
  /** The platform's ID for them, which never changes: `U0456`, a GitHub account's number, a Linear user's ID. */
  readonly id: string;
  /** The name they go by, when the event says. */
  readonly name: string | null;
  /** What they are mentioned by on the platform, when that isn't the ID: a GitHub login. */
  readonly login?: string | null;
}

/**
 * The profile a platform user writes under: the sync entry they came through,
 * and their ID on its platform. No request can name it, since a profile a
 * request names holds no colon.
 */
export function platformProfile(key: string, userId: string): string {
  return `${key}:user:${userId}`;
}

/**
 * The actor a platform user is on the vibe: a profile of the service that
 * syncs them, such as `vibe:service:s_…+slack:user:U0456`. Each sync entry's
 * users are actors of their own.
 */
export function platformActorId(principal: string, key: string, userId: string): string {
  return `${principal}+${platformProfile(key, userId)}`;
}

/**
 * The platform's ID of the user an actor is, when the actor is one that this
 * entry brought in. `null` for everyone else: a person, an agent, another
 * entry's user.
 */
export function platformUserOf(principal: string, key: string, actorId: string): string | null {
  const prefix = platformActorId(principal, key, "");
  return actorId.startsWith(prefix) && actorId.length > prefix.length
    ? actorId.slice(prefix.length)
    : null;
}

const MAX_SLUG = 24;

/** A name as a handle can hold it: lowercase letters, numbers and hyphens. */
export function slug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
}

/**
 * What a platform user's handle starts with, after the service they are shown
 * through. Identity refuses it as the start of a profile's name, so the two
 * can't take each other's handles.
 */
const PREFIX = "u-";

/**
 * The handles a platform user may take, the first that is free: their name
 * under the service that syncs them, such as `support/u-malte`, then the same
 * with their ID, which no one else has.
 */
export function platformHandles(service: string, user: PlatformUser): [string, string] {
  const id = slug(user.id) || "user";
  const name = slug(user.login ?? user.name ?? "") || id;
  // The end of an ID is the part that tells two of them apart.
  const told = `${name.slice(0, 14)}-${id.slice(-14)}`.replace(/-+/g, "-");
  return [`${service}/${PREFIX}${name}`, `${service}/${PREFIX}${told}`];
}

/** What a platform user is called where no name came with them. */
export function platformName(user: PlatformUser): string {
  return (user.name ?? user.login ?? "").trim() || user.id;
}
