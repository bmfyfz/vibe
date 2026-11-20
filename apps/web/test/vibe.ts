import { vibe as connect, type VibeHandle } from "@vibe/sdk";
import { createVibe } from "@vibe/server";
import { createDb } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";
import { memoryBlobStore } from "@vibe/store/memory";

import { type Services, servicesAt } from "../src/state/services.ts";
import { ORIGIN } from "./dom.ts";

const ADMIN = "web-test-admin-secret";

/** What a test does with one of the page's requests: `pass` hands it on to the Vibe. */
type Between = (
  input: string,
  init: RequestInit,
  pass: () => Promise<Response>,
) => Promise<Response>;

/**
 * A whole Vibe in this process, and a browser's side of it: a `fetch` that
 * keeps the cookies it is given and says where its requests come from, as a
 * browser does for a page. The page under test talks to the real API through
 * the real SDK. Nothing is mocked.
 */
export function testVibe() {
  // The stores are Bun's own, made before the page's globals could stand in for them.
  const app = createVibe({
    db: createDb(bunSqliteExecutor(openDatabase())),
    blobs: memoryBlobStore(),
    adminSecret: ADMIN,
    pollIntervalMs: 5,
  });
  const server = (input: string, init?: RequestInit) => app.app.handle(new Request(input, init));

  let cookie = "";
  let between: Between | null = null;
  const requests: { method: string; url: string; authorization: string | null }[] = [];
  /** The page's `fetch`: same-origin requests carry the session's cookie and the page's origin. */
  const browser = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("origin", ORIGIN);
    if (cookie !== "") headers.set("cookie", cookie);
    requests.push({
      method: init.method ?? "GET",
      url: input,
      authorization: headers.get("authorization"),
    });
    const pass = () => server(input, { ...init, headers });
    const response = await (between === null ? pass() : between(input, init, pass));
    const set = response.headers.get("set-cookie");
    if (set !== null) {
      const [pair = ""] = set.split("; ");
      cookie = pair.endsWith("=") ? "" : pair;
    }
    return response;
  };

  let counter = 0;
  return {
    /** What the page is given to reach the Vibe. Its handles wait with long-polls: there is no socket here. */
    services: servicesAt(ORIGIN, browser, { live: false }) satisfies Services,
    /**
     * Stands between the page and the Vibe from now on: to answer in the
     * Vibe's place, or to have something happen before the Vibe's answer
     * reaches the page. `null` steps out again.
     */
    stepIn(how: Between | null) {
      between = how;
    },
    /** Every request the page made, to check what it sent. */
    requests,
    /** The cookie the browser holds, or an empty string when it holds none. */
    cookie: () => cookie,
    /** Adds a person, and returns their token and a client that acts as them from outside the page. */
    async join(
      role?: "owner" | "member" | "viewer",
      handle = `u${++counter}`,
    ): Promise<{ handle: string; token: string; client: VibeHandle }> {
      const response = await server(`${ORIGIN}/v1/admin/users`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify(role ? { handle, role } : { handle }),
      });
      if (!response.ok) throw new Error(`Could not add ${handle}: ${await response.text()}`);
      const { token } = (await response.json()) as { token: string };
      return {
        handle,
        token,
        client: connect({ url: ORIGIN, token, fetch: server, live: false }),
      };
    },
  };
}
