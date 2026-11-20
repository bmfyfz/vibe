import type { DeviceLogin, DeviceLoginResult } from "@vibe/contracts";

import { askAgainIn, failure, signInRanOut, VibeError } from "./duration.ts";

export interface DeviceLoginOptions {
  /** Where Vibe is served. */
  url: string;
  /**
   * Called once, with the code for the person to enter and the page to enter
   * it on. Show them both: the sign-in waits until they approve it there.
   */
  onCode(code: DeviceLogin): void | Promise<void>;
  fetch?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  /** Abort to give up waiting. */
  signal?: AbortSignal | undefined;
  /** How to wait between asks. A timer, unless a test stands in for it. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface LoggedIn {
  /** A new Vibe token of the person who signed in. It is shown this once. */
  token: string;
  user: { id: string; handle: string; name: string; role: "owner" | "member" | "viewer" };
  /** `true` when this sign-in added them to the team. */
  created: boolean;
}

/**
 * Signs a person in through GitHub's device flow, for a program with no
 * browser of its own: Vibe gives a code, the person approves it at GitHub in
 * any browser, and Vibe issues its own token for whoever that GitHub account
 * belongs to on the team. Nothing of GitHub's is kept, here or there.
 *
 * It asks no more often than GitHub allows, and resolves when the person has
 * approved.
 *
 * @throws `login_unavailable` when the Vibe has no GitHub sign-in,
 *   `login_denied` when the person said no, `login_expired` when the code ran
 *   out, and `signup_closed` when the account is no one's on the team.
 */
export async function deviceLogin(options: DeviceLoginOptions): Promise<LoggedIn> {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const base = options.url.replace(/\/+$/, "");
  const post = async <T>(path: string, json?: unknown): Promise<T> => {
    const init: RequestInit = { method: "POST" };
    if (json !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(json);
    }
    if (options.signal) init.signal = options.signal;
    const response = await send(`${base}${path}`, init);
    if (response.ok) return (await response.json()) as T;
    throw await failure(response);
  };

  const code = await post<DeviceLogin>("/v1/login/device");
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
    let result: DeviceLoginResult;
    try {
      result = await post<DeviceLoginResult>("/v1/login/device/token", {
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
      return { token: result.token, user: result.user, created: result.created };
    }
    // GitHub says when it is asked too often, and how long to leave it from then on.
    if (result.interval !== null) interval = result.interval;
    pause = interval;
  }
}
