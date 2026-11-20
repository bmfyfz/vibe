export type PrincipalKind = "user" | "service";

/** The ID of a principal acting as itself, such as `vibe:user:u_01jd…`. */
export function principalId(kind: PrincipalKind, id: string): string {
  return `vibe:${kind}:${id}`;
}

/** What kind of principal an ID names, or `null` when it names none. */
export function principalKindOf(principal: string): PrincipalKind | null {
  if (principal.startsWith("vibe:user:")) return "user";
  if (principal.startsWith("vibe:service:")) return "service";
  return null;
}

/** The ID of a profile of a principal, such as `vibe:user:u_01jd…+fx`. */
export function profileActorId(principal: string, profile: string): string {
  return `${principal}+${profile.toLowerCase()}`;
}

/** The principal behind an actor ID: the ID itself, or what comes before `+profile`. */
export function principalOf(actorId: string): string {
  const plus = actorId.indexOf("+");
  return plus === -1 ? actorId : actorId.slice(0, plus);
}
