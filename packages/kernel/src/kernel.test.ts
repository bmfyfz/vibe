import { describe, expect, test } from "bun:test";

import {
  compareSpecificity,
  ConstraintViolation,
  coversPattern,
  DomainError,
  findConstraintViolation,
  matchesChannel,
  newId,
  parseChannelPath,
  parseChannelPattern,
  parseLabelFilter,
  parseLabelFilters,
  subtreeBounds,
} from "./index.ts";

describe("channel paths", () => {
  test("accepts segments of lowercase letters, numbers, _ and -", () => {
    for (const path of ["dev", "errors-www", "www/production", "a_b/c-d/9"]) {
      expect(parseChannelPath(path) as string).toBe(path);
    }
  });

  test("rejects everything else with invalid_channel", () => {
    for (const path of ["", "Dev", "www/", "/www", "a//b", "a b", "a.b", "x".repeat(129)]) {
      expect(() => parseChannelPath(path)).toThrow(DomainError);
    }
  });

  test("a trailing slash names a subtree", () => {
    const subtree = parseChannelPattern("www/");
    expect(subtree).toEqual({ kind: "subtree", prefix: "www/" });
    expect(matchesChannel(subtree, "www/production")).toBe(true);
    expect(matchesChannel(subtree, "www")).toBe(false);
    expect(matchesChannel(subtree, "wwwx/production")).toBe(false);
    expect(matchesChannel(parseChannelPattern("www"), "www/production")).toBe(false);
    expect(matchesChannel(parseChannelPattern(undefined), "anything")).toBe(true);
  });

  test("subtree bounds hold exactly the paths under the prefix", () => {
    const [low, high] = subtreeBounds("www/");
    const inside = (path: string) => path >= low && path < high;
    expect(inside("www/a")).toBe(true);
    expect(inside("www/_x/y")).toBe(true);
    expect(inside("www")).toBe(false);
    expect(inside("www-old/a")).toBe(false);
    expect(inside("www0")).toBe(false);
  });
});

describe("channel patterns", () => {
  const pattern = parseChannelPattern;

  test("a pattern covers the patterns that hold only channels it holds", () => {
    expect(coversPattern(pattern("*"), pattern("www/"))).toBe(true);
    expect(coversPattern(pattern("www/"), pattern("www/production"))).toBe(true);
    expect(coversPattern(pattern("www/"), pattern("www/production/"))).toBe(true);
    expect(coversPattern(pattern("www/"), pattern("www/"))).toBe(true);
    expect(coversPattern(pattern("www/"), pattern("www"))).toBe(false);
    expect(coversPattern(pattern("www/production/"), pattern("www/"))).toBe(false);
    expect(coversPattern(pattern("www"), pattern("www"))).toBe(true);
    expect(coversPattern(pattern("www"), pattern("www/"))).toBe(false);
    expect(coversPattern(pattern("www/"), pattern("*"))).toBe(false);
  });

  test("the most specific sorts first: exact, then the longest subtree, then everything", () => {
    const sorted = ["*", "a/", "a/b/", "a/b/c", "z"].map(pattern).sort(compareSpecificity);
    expect(sorted.map((p) => p.kind)).toEqual(["exact", "exact", "subtree", "subtree", "all"]);
    expect(sorted[2]).toEqual({ kind: "subtree", prefix: "a/b/" });
  });
});

describe("ids", () => {
  test("are prefixed, fixed-length and unique", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("msg")));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^msg_[0-9a-z]{26}$/);
  });
});

describe("constraint violations", () => {
  test("are found in D1 and SQLite messages, through causes", () => {
    const d1 = new Error(
      "D1_ERROR: UNIQUE constraint failed: events.thread_id, events.thread_version: SQLITE_CONSTRAINT",
    );
    const wrapped = new Error("Failed query", { cause: d1 });
    const found = findConstraintViolation(wrapped);
    expect(found).toBeInstanceOf(ConstraintViolation);
    expect(found?.columns).toEqual(["events.thread_id", "events.thread_version"]);
    expect(found?.on("events")).toBe(true);
    expect(found?.on("messages")).toBe(false);
  });

  test("ignore unrelated errors", () => {
    expect(findConstraintViolation(new Error("no such table: t"))).toBeNull();
    expect(findConstraintViolation(undefined)).toBeNull();
  });
});

describe("label filters", () => {
  test("name a key, a value, or several values", () => {
    expect(parseLabelFilter("status")).toEqual({ key: "status", values: null });
    expect(parseLabelFilter("status=open")).toEqual({ key: "status", values: ["open"] });
    expect(parseLabelFilter("dup-of=640|a=b")).toEqual({ key: "dup-of", values: ["640", "a=b"] });
    expect(parseLabelFilter("vibe.task=ready").key).toBe("vibe.task");
  });

  test("refuse keys that aren't label keys", () => {
    for (const bad of ["", "=open", "Status", "-x", "a b=c", `${"k".repeat(65)}=v`]) {
      expect(() => parseLabelFilter(bad)).toThrow(DomainError);
    }
    // Bounded, because each value and each filter is a bound parameter.
    expect(() => parseLabelFilter(`k=${"v|".repeat(8)}v`)).toThrow(DomainError);
    expect(parseLabelFilters(["a", "b=1", "c", "d"])).toHaveLength(4);
    expect(() => parseLabelFilters(["a", "b", "c", "d", "e"])).toThrow(DomainError);
  });
});
