import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

/**
 * What goes out with the web app's page and its files, whoever serves them.
 * The Worker takes the same from `apps/web/public/_headers`, and a test holds
 * the two together.
 *
 * The policy is the page's second defence against a script that shouldn't be
 * there, after the renderer that never trusts a message as HTML: nothing
 * loads or runs but the app's own files, the page talks to no origin but its
 * own, and no other site can frame it.
 */
export const WEB_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Answers a request with a file of the web app, or with `null` for a request that isn't for one. */
export type WebSite = (request: Request) => Response | null;

/**
 * The web app, served from the directory it was built into. A path that names
 * a file gets the file. Any other path gets the app itself, which reads the
 * path: `/v/general/c/dev` is a place in the app, not a file.
 *
 * @returns `null` when there is no built app in the directory.
 */
export function webSite(directory: string): WebSite | null {
  const root = normalize(directory);
  if (!existsSync(join(root, "index.html"))) return null;

  return (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return null;
    }
    // Only what is inside the directory is served, however the path is spelled.
    const wanted = normalize(join(root, pathname));
    const inside = wanted === root || wanted.startsWith(root + sep);
    const isFile =
      inside && extname(wanted) !== "" && existsSync(wanted) && statSync(wanted).isFile();
    if (!isFile && extname(pathname) !== "" && !pathname.endsWith(".html")) {
      // A file the app doesn't have. Answering with the app would hide the mistake.
      return new Response("Not found", { status: 404, headers: { ...WEB_HEADERS } });
    }
    const file = isFile ? wanted : join(root, "index.html");
    // Vite names a built file after its content, so one under `assets/` never changes.
    const fixed = isFile && pathname.startsWith("/assets/");
    return new Response(request.method === "HEAD" ? null : Bun.file(file), {
      headers: {
        ...WEB_HEADERS,
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": fixed ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  };
}
