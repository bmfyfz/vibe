import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import { DomainError } from "@vibe/kernel";

import {
  backoffMs,
  filterOf,
  parseWatcherName,
  parseWatcherUrl,
  settleTail,
  signDelivery,
  watcherActor,
} from "./watcher.ts";

describe("a watcher", () => {
  test("is named as a profile is", () => {
    expect(parseWatcherName("Triage-1")).toBe("triage-1");
    for (const bad of ["", "1st", "a_b", "a/b", "x".repeat(33)]) {
      expect(() => parseWatcherName(bad)).toThrow(DomainError);
    }
  });

  test("posts to https, or to http on this machine, and carries no credentials", () => {
    expect(parseWatcherUrl("https://example.com/hooks/vibe")).toBe(
      "https://example.com/hooks/vibe",
    );
    expect(parseWatcherUrl("http://localhost:3000/hook")).toBe("http://localhost:3000/hook");
    expect(parseWatcherUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
    for (const bad of [
      "",
      "not a url",
      "http://example.com/hook",
      "ftp://example.com/hook",
      "https://user:secret@example.com/hook",
      `https://example.com/${"x".repeat(2000)}`,
    ]) {
      expect(() => parseWatcherUrl(bad)).toThrow(DomainError);
    }
  });

  test("follows what a tail would, in one spelling", () => {
    const tail = settleTail({ channel: "www/", labels: ["state=open|draft", "pr"], by: "ada" });
    expect(tail).toEqual({
      channel: "www/",
      re: null,
      by: "ada",
      labels: ["state=open|draft", "pr"],
      mentions: null,
      source: null,
      all: false,
    });
    expect(settleTail({}).channel).toBe("*");
    expect(settleTail({ source: " Slack " }).source).toBe("slack");
    expect(filterOf(tail)).toMatchObject({
      channel: { kind: "subtree", prefix: "www/" },
      by: "ada",
      labels: [
        { key: "state", values: ["open", "draft"] },
        { key: "pr", values: null },
      ],
    });
    expect(() => settleTail({ channel: "Not A Channel" })).toThrow(DomainError);
    expect(() => settleTail({ labels: ["=open"] })).toThrow(DomainError);
  });

  test("writes as whoever registered it, under its own name", () => {
    expect(watcherActor({ principal: "vibe:service:s_ci", name: "triage" })).toBe(
      "vibe:service:s_ci+triage",
    );
  });

  test("leaves a failing endpoint alone for longer each time, up to an hour", () => {
    expect([1, 2, 3, 7, 8, 100].map(backoffMs)).toEqual([
      2_000, 10_000, 30_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });

  test("signs the timestamp and the body with its secret", async () => {
    const body = JSON.stringify({ hello: "world" });
    const expected = createHmac("sha256", "vibe_whsec_test").update(`1700000000.${body}`);
    expect(await signDelivery("vibe_whsec_test", 1_700_000_000, body)).toBe(
      `v1=${expected.digest("hex")}`,
    );
    expect(await signDelivery("vibe_whsec_test", 1_700_000_001, body)).not.toBe(
      await signDelivery("vibe_whsec_test", 1_700_000_000, body),
    );
  });
});
