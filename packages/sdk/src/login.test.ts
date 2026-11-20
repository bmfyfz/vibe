import { describe, expect, test } from "bun:test";

import { deviceLogin, signInWithGitHub, VibeError } from "./index.ts";

const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));

/** A Vibe that hands out a code and then answers every ask the same way. */
function answering(ask: () => Response, expiresIn = 900) {
  let asks = 0;
  const fetch = async (input: string) => {
    if (input.endsWith("/v1/login/device")) {
      return Response.json({
        deviceCode: "device",
        userCode: "USER-CODE",
        verificationUri: "https://github.com/login/device",
        expiresIn,
        interval: 5,
      });
    }
    asks += 1;
    return ask();
  };
  return { fetch, asks: () => asks };
}

const tooOften = (retryAfter: string) => () =>
  Response.json(
    { code: "rate_limited", message: "Too often." },
    { status: 429, headers: { "retry-after": retryAfter } },
  );

describe("waiting on a sign-in", () => {
  for (const [name, signIn] of [
    ["deviceLogin", deviceLogin],
    ["signInWithGitHub", signInWithGitHub],
  ] as const) {
    test(`${name} waits no longer than a minute, whatever it is told`, async () => {
      // A day, and a number of seconds no timer can hold.
      for (const told of ["86400", "4000000", "-3", "soon"]) {
        const { fetch } = answering(tooOften(told));
        const slept: number[] = [];
        const error = await signIn({
          url: "http://vibe.test",
          fetch,
          onCode() {},
          async sleep(ms) {
            slept.push(ms);
          },
        }).catch((e: unknown) => e);
        // It gives up when the code has run out, and not before or never.
        expect(code(error)).toBe("login_expired");
        expect(Math.max(...slept)).toBeLessThanOrEqual(60_000);
        expect(Math.min(...slept)).toBeGreaterThanOrEqual(5000);
        expect(slept.reduce((sum, ms) => sum + ms, 0)).toBeGreaterThanOrEqual(900_000);
        expect(slept.length).toBeLessThanOrEqual(181);
      }
    });

    test(`${name} stops asking once the code has run out, though it is only ever told to wait`, async () => {
      const { fetch, asks } = answering(
        () => Response.json({ status: "pending", interval: null }),
        30,
      );
      const error = await signIn({
        url: "http://vibe.test",
        fetch,
        onCode() {},
        async sleep() {},
      }).catch((e: unknown) => e);
      expect(code(error)).toBe("login_expired");
      expect(asks()).toBe(6);
    });
  }
});
