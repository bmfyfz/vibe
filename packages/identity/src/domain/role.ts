/** A person's place on the team. */
export type PersonRole = "owner" | "member" | "viewer";

/**
 * What caps a principal's access. A person has a role on the team. A service
 * has none of those: `service` puts no ceiling of its own on it, so its grants
 * alone decide, and it is never an owner.
 */
export type Role = PersonRole | "service";

export const PERMISSIONS = ["read", "post", "react", "label", "sync", "manage"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

const ALLOWED: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  member: new Set(PERMISSIONS),
  viewer: new Set(["read", "react"]),
  service: new Set(PERMISSIONS),
};

/** The most a role allows anywhere. Grants narrow this per channel; they never widen it. */
export function roleAllows(role: Role, permission: Permission): boolean {
  return ALLOWED[role].has(permission);
}
