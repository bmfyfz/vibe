import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";

import {
  addressKey,
  attemptKey,
  type Budget,
  REFUSED_CREDENTIALS,
  tooManyAttempts,
  windowAt,
} from "./attempts.ts";

const budget: Budget = { name: "test", most: 3, windowMs: 60_000, refusal: "Too many." };

describe("the stretch attempts are counted in", () => {
  test("stretches lie end to end from the epoch, whoever asks", () => {
    expect(windowAt(budget, 0)).toEqual({ start: 0, end: 60_000 });
    expect(windowAt(budget, 59_999)).toEqual({ start: 0, end: 60_000 });
    expect(windowAt(budget, 60_000)).toEqual({ start: 60_000, end: 120_000 });
    expect(windowAt(budget, 1_795_000_012_345)).toEqual({
      start: 1_794_999_960_000,
      end: 1_795_000_020_000,
    });
  });

  test("a refusal says how long is left of the stretch, and never nothing", () => {
    const refused = tooManyAttempts(budget, 60_000 + 12_500);
    expect(refused).toBeInstanceOf(DomainError);
    expect([refused.kind, refused.code]).toEqual(["rate_limited", "rate_limited"]);
    expect(refused.retryAfterMs).toBe(47_500);
    expect(refused.hint).toBe("Try again in 48 seconds.");
    expect(tooManyAttempts(budget, 119_999).retryAfterMs).toBe(1);
  });

  test("a key names what is counted, and for whom", () => {
    expect(attemptKey(REFUSED_CREDENTIALS, "203.0.113.7")).toBe("credential:203.0.113.7");
  });
});

describe("who an address is counted as", () => {
  test("an IPv4 address is itself", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  test("a port after an address is the connection's, and is left off", () => {
    expect(addressKey("203.0.113.7:51234")).toBe("203.0.113.7");
    expect(addressKey("203.0.113.7:51235")).toBe("203.0.113.7");
    expect(addressKey("[2001:db8:1:2::9]:51234")).toBe("2001:db8:1:2::/64");
  });

  test("an IPv6 address is its network: whoever has one address of it has them all", () => {
    expect(addressKey("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:DB8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::9")).toBe("2001:db8:1:3::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("[2001:db8:1:2::9]:443")).toBe("2001:db8:1:2::/64");
    expect(addressKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
  });

  test("an IPv4 address written as IPv6 is the IPv4 address", () => {
    expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("::ffff:cb00:7107")).toBe("203.0.113.7");
    expect(addressKey("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
    // Not the mapped range: an address of its own.
    expect(addressKey("64:ff9b::203.0.113.7")).toBe("64:ff9b:0:0::/64");
  });

  test("what isn't an address is still someone, and never grows without bound", () => {
    expect(addressKey("not an address")).toBe("not an address");
    expect(addressKey("1:2:3")).toBe("1:2:3");
    expect(addressKey("1::2::3")).toBe("1::2::3");
    expect(addressKey("::ffff:999.0.0.1")).toBe("::ffff:999.0.0.1");
    expect(addressKey("g::1")).toBe("g::1");
    expect(addressKey("x".repeat(500))).toHaveLength(64);
    expect(addressKey("")).toBe("");
  });
});
