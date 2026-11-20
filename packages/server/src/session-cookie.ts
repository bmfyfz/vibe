import { forbidden } from "@vibe/kernel";

// Over HTTPS the cookie's name carries `__Host-`: a browser then takes it
// only from this exact host, over HTTPS, for every path, so no other site
// under the same domain can set one of its own in its place. Over plain HTTP,
// which is a Vibe on this machine, a browser refuses that prefix.
const NAME = "vibe_session";
const HOST_NAME = `__Host-${NAME}`;

const isSecure = (request: Request) => new URL(request.url).protocol === "https:";

/** The session secret a request's cookie carries, or `null` when it carries none. */
export function sessionOf(request: Request): string | null {
  const wanted = isSecure(request) ? HOST_NAME : NAME;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const equals = part.indexOf("=");
    if (equals !== -1 && part.slice(0, equals).trim() === wanted) {
      return part.slice(equals + 1).trim() || null;
    }
  }
  return null;
}

/**
 * The `Set-Cookie` that hands a browser its session.
 *
 * - `HttpOnly`: no script on the page can read it, so a script that should
 *   not be there can't carry the session off.
 * - `SameSite=Strict`: it is sent only with requests the Vibe's own pages
 *   make, never with one another site caused.
 * - `Secure`, over HTTPS: it never crosses the network in the clear.
 */
export function sessionCookie(request: Request, secret: string, lifetimeMs: number): string {
  const seconds = Math.max(0, Math.floor(lifetimeMs / 1000));
  return cookie(request, secret, seconds);
}

/** The `Set-Cookie` that takes a browser's session away. */
export function clearedSessionCookie(request: Request): string {
  return cookie(request, "", 0);
}

function cookie(request: Request, value: string, maxAge: number): string {
  const secure = isSecure(request);
  return [
    `${secure ? HOST_NAME : NAME}=${value}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Refuses a request that a page of another site caused. A browser says where
 * a request came from in `Origin`, and no page can change what it says. A
 * request that rides on a session's cookie must have come from the Vibe's own
 * pages: the cookie is the browser's to send, not the page's to hold, so the
 * cookie alone doesn't show that the person meant it.
 *
 * A request that carries a token needs no such check. A token is something
 * its sender had to have.
 */
export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin !== null && origin === new URL(request.url).origin) return;
  throw forbidden(
    "forbidden",
    "This request rides on a browser's session, and did not come from this Vibe's own pages.",
    "From a program, send a token instead: Authorization: Bearer <TOKEN>.",
  );
}

/** Whether a request only reads: one a browser may make on a page's behalf without asking. */
export function isRead(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}
