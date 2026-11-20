import { describe, expect, test } from "bun:test";

import { canIn } from "../src/lib/access.ts";
import { channelTree, matchesPattern, patternOf, visibleNodes } from "../src/lib/channel-tree.ts";
import { shownLabels, stateOf } from "../src/lib/holder.ts";
import { formatPlace, parsePlace } from "../src/lib/route.ts";
import { firstLines, MENTION_SCHEME, mentionAt, who, withMentions } from "../src/lib/text.ts";
import { ago, milliseconds, remaining } from "../src/lib/time.ts";

describe("the channel tree", () => {
  const tree = channelTree(["www/production", "dev", "www/staging", "www", "ops/db/replicas"]);

  test("is what the paths spell, whether or not a parent is a channel itself", () => {
    const shape = (nodes: typeof tree): unknown =>
      nodes.map((node) => [node.name, node.isChannel, shape(node.children)]);
    expect(shape(tree)).toEqual([
      ["dev", true, []],
      ["ops", false, [["db", false, [["replicas", true, []]]]]],
      [
        "www",
        true,
        [
          ["production", true, []],
          ["staging", true, []],
        ],
      ],
    ]);
  });

  test("lists what is open, and asks for a channel or for everything under a place", () => {
    const paths = (closed: string[]) =>
      visibleNodes(tree, new Set(closed)).map(({ node, depth }) => `${depth}:${node.path}`);
    expect(paths(["ops"])).toEqual([
      "0:dev",
      "0:ops",
      "0:www",
      "1:www/production",
      "1:www/staging",
    ]);
    const [, ops, www] = tree;
    expect(ops && patternOf(ops)).toBe("ops/");
    expect(www && patternOf(www)).toBe("www");
    expect(matchesPattern("ops/", "ops/db/replicas")).toBe(true);
    expect(matchesPattern("www", "www/production")).toBe(false);
    expect(matchesPattern(null, "anything")).toBe(true);
  });
});

describe("what you can do in a channel", () => {
  const can = {
    "*": ["read", "post", "react", "label", "sync", "manage"],
    "security/": [],
    "security/incidents": ["read"],
  } as const;

  test("is decided by the most specific pattern, as on the server", () => {
    expect([...canIn(can, "dev")]).toContain("post");
    expect([...canIn(can, "security/audits")]).toEqual([]);
    expect([...canIn(can, "security/incidents")]).toEqual(["read"]);
    expect([...canIn(undefined, "dev")]).toEqual([]);
    // Above one channel, what you can do somewhere is what may be offered.
    expect(canIn(can, null).has("post")).toBe(true);
    expect(canIn({ "dev/": ["read"] }, "www/").has("post")).toBe(false);
  });
});

describe("a strip's first box", () => {
  test("says a task's state, or the state label agents and synced platforms keep", () => {
    expect(stateOf({ labels: { "vibe.task": "claimed", state: "open" } })).toEqual({
      word: "claimed",
      holder: "claimed",
      task: true,
    });
    expect(stateOf({ labels: { state: "merged" } })).toMatchObject({ holder: "done", task: false });
    expect(stateOf({ labels: { state: "something-new" } })?.holder).toBe("waiting");
    // Work that is stuck asks for someone; work that failed or was called off is over.
    expect(stateOf({ labels: { state: "blocked" } })?.holder).toBe("blocked");
    expect(stateOf({ labels: { "vibe.task": "failed" } })?.holder).toBe("ended");
    expect(stateOf({ labels: { state: "canceled" } })?.holder).toBe("ended");
    expect(stateOf({ labels: { kind: "bug" } })).toBeNull();
  });

  test("leaves the labels to say what it doesn't", () => {
    expect(shownLabels({ labels: { "vibe.task": "ready", step: "fix" } })).toEqual([
      ["step", "fix"],
    ]);
    expect(shownLabels({ labels: { state: "open", kind: "bug" } })).toEqual([["kind", "bug"]]);
    // On a task, `state` is someone's own label, and is shown.
    expect(shownLabels({ labels: { "vibe.task": "ready", state: "x" } })).toEqual([["state", "x"]]);
  });
});

describe("places", () => {
  test("round-trip through the address, slashes and all", () => {
    const place = { vibe: "general", channel: "www/production", thread: "msg_01abc" };
    expect(formatPlace(place)).toBe("/v/general/c/www/production?t=msg_01abc");
    expect(parsePlace("/v/general/c/www/production", "?t=msg_01abc")).toEqual(place);
    expect(parsePlace("/v/general/c/www/", "")).toEqual({
      ...place,
      channel: "www/",
      thread: null,
    });
    expect(parsePlace("/", "")).toEqual({ vibe: "general", channel: null, thread: null });
    expect(formatPlace({ vibe: "security", channel: null, thread: null })).toBe("/v/security");
  });
});

describe("text", () => {
  const ada = { actor: "vibe:user:u_1", handle: "ada", name: "Ada" };

  test("an actor is shown by name, a profile with who is behind it", () => {
    expect(who({ name: "Ada", handle: "ada", profile: null })).toBe("Ada");
    expect(who({ name: "fx", handle: "ada/fx", profile: "fx" })).toBe("fx via ada");
    expect(who({ name: "Malte", handle: "support/malte", profile: "slack:user:U1" })).toBe(
      "Malte via support",
    );
  });

  test("a stored mention is shown by handle, as a link the renderer knows for a mention", () => {
    const message = { text: "cc @[vibe:user:u_1], thanks", mentions: [ada] };
    expect(withMentions(message)).toBe(`cc [@ada](${MENTION_SCHEME}vibe%3Auser%3Au_1), thanks`);
    // The scheme is the page's own, new at each load: a message can't spell it.
    expect(MENTION_SCHEME).toMatch(/^mention-[0-9a-f]{32}:$/);
    expect(
      firstLines({
        text: "# Plan\n\n**Ship** it, @[vibe:user:u_1]\n```\ncode\n```",
        mentions: [ada],
      }),
    ).toBe("Plan Ship it, @ada (code)");
  });

  test("a handle being typed is found at the caret, and nowhere else", () => {
    expect(mentionAt("hello @ad", 9)).toEqual({ start: 6, typed: "ad" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, typed: "" });
    expect(mentionAt("mail ada@example.com", 20)).toBeNull();
    expect(mentionAt("hello @ada there", 16)).toBeNull();
  });

  test("times read short", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    expect(ago("2026-11-19T11:59:40Z", now)).toBe("now");
    expect(ago("2026-11-19T11:15:00Z", now)).toBe("45m");
    expect(ago("2026-11-18T06:00:00Z", now)).toBe("1d");
    expect(remaining("2026-11-19T12:02:10Z", now)).toBe("2m 10s");
    expect(remaining("2026-11-19T11:59:00Z", now)).toBeNull();
  });
});

describe("a duration read back from the page", () => {
  test("is in milliseconds, whichever unit the build wrote it in", () => {
    expect(milliseconds("200ms", 0)).toBe(200);
    expect(milliseconds(" .2s", 0)).toBe(200);
    expect(milliseconds("1ms", 0)).toBe(1);
    expect(milliseconds("", 200)).toBe(200);
  });
});
