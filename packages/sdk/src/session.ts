import type { BrowserSession, DeviceLogin, DeviceSessionResult, SignInWays } from "@vibe/contracts";

import { askAgainIn, failure, signInRanOut, VibeError } from "./duration.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionOptions {
  /** Where Vibe is served. For a page the Vibe itself serves, leave it out: the page's own origin. */
  url?: string | undefined;
  fetch?: Fetch | undefined;
  /** Abort to give up waiting. */
  signal?: AbortSignal | undefined;
}

/**
 * Signing in from a browser. A page has nowhere safe to keep a token, so it
 * keeps none: Vibe puts a session in a cookie that the page's scripts can't
 * read, and the browser sends it with every request the page makes to the
 * Vibe that served it. `vibe()` then needs no token at all.
 */
function requester(options: SessionOptions) {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const base = (options.url ?? "").replace(/\/+$/, "");
  return async <T>(method: string, path: string, json?: unknown): Promise<T> => {
    const init: RequestInit = { method };
    if (json !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(json);
    }
    if (options.signal) init.signal = options.signal;
    const response = await send(`${base}${path}`, init);
    if (response.ok) return (await response.json()) as T;
    throw await failure(response);
  };
}

/** The ways this Vibe lets a person sign in: with a token always, and through GitHub where it is set up. */
export function signInWays(options: SessionOptions = {}): Promise<SignInWays> {
  return requester(options)("GET", "/v1/login");
}

/**
 * Signs the browser in with a token of the person's own. The token is sent
 * this once and not kept: the browser goes on with a session.
 *
 * @throws `unauthorized` for a token Vibe doesn't know, and `forbidden` for
 *   a service's or a delegated one.
 */
export function signIn(token: string, options: SessionOptions = {}): Promise<BrowserSession> {
  return requester(options)("POST", "/v1/session", { token: token.trim() });
}

/**
 * Signs the browser in through GitHub's device flow: Vibe gives a code, the
 * person approves it at GitHub, and the browser gets a session. No token is
 * minted for it.
 *
 * @param options.onCode Called once with the code to show, and the page to enter it on.
 * @throws What `deviceLogin` throws.
 */
export async function signInWithGitHub(
  options: SessionOptions & {
    onCode(code: DeviceLogin): void | Promise<void>;
    sleep?: ((ms: number) => Promise<void>) | undefined;
  },
): Promise<BrowserSession & { created: boolean }> {
  const request = requester(options);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const code = await request<DeviceLogin>("POST", "/v1/login/device");
  await options.onCode(code);

  let interval = code.interval;
  let pause = interval;
  // How long it has waited in all. Past the code's own life nothing can come
  // of asking, whatever the answers say.
  let waited = 0;
  for (;;) {
    if (waited >= code.expiresIn) throw signInRanOut();
    await sleep(pause * 1000);
    waited += pause;
    pause = interval;
    if (options.signal?.aborted) throw new VibeError("aborted", "The sign-in was called off.", 0);
    let result: DeviceSessionResult;
    try {
      result = await request<DeviceSessionResult>("POST", "/v1/session/device", {
        deviceCode: code.deviceCode,
      });
    } catch (error) {
      // Asked too often for this address: the sign-in still stands, so wait it out.
      const wait = askAgainIn(error);
      if (wait === null) throw error;
      pause = Math.max(interval, wait);
      continue;
    }
    if (result.status === "complete") {
      return { user: result.user, expiresAt: result.expiresAt, created: result.created };
    }
    // GitHub says when it is asked too often, and how long to leave it from then on.
    if (result.interval !== null) interval = result.interval;
    pause = interval;
  }
}

/** Signs the browser out. The session is over, wherever its cookie still is. */
export async function signOut(options: SessionOptions = {}): Promise<void> {
  await requester(options)("DELETE", "/v1/session");
}
