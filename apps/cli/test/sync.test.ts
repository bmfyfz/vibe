import { describe, expect, test } from "bun:test";

import { formatThread } from "../src/format.ts";
import { UsageError } from "../src/shared.ts";
import { formatSource, formatSynced, mappings } from "../src/sync.ts";

describe("vibe sources create --map", () => {
  test("reads a platform channel and the vibe channel it syncs with", () => {
    expect(mappings(["#errors=errors-www", "C0123ABC=incidents"], false)).toEqual({
      "#errors": "errors-www",
      C0123ABC: "incidents",
    });
    expect(mappings(["ENG=dev"], false)).toEqual({ ENG: "dev" });
  });

  test("reads a repository's pull requests and issues into channels of their own", () => {
    expect(
      mappings(["acme/www=dev", "acme/api:pulls=prs", "acme/api:issues=issues"], false),
    ).toEqual({ "acme/www": "dev", "acme/api": { pulls: "prs", issues: "issues" } });
    expect(mappings(["acme/www=dev"], true)).toEqual({
      "acme/www": { channel: "dev", replies: true },
    });
  });

  test("refuses what isn't a mapping", () => {
    for (const bad of ["#errors", "=dev", "#errors="]) {
      expect(() => mappings([bad], false)).toThrow(UsageError);
    }
  });
});

describe("what sync prints", () => {
  const source = {
    id: "src_1",
    key: "slack",
    platform: "slack" as const,
    service: { id: "vibe:service:s_1", handle: "support" },
    mappings: [{ platform: "#errors", channel: "errors-www", only: null, out: true }],
    state: "active" as const,
    reason: null,
    webhook: "/v1/sync/webhooks/src_1",
    api: "https://slack.com/api",
    cursor: "cur_1",
    pending: 2,
    failed: 1,
    createdAt: "2026-11-19T10:00:00.000Z",
  };

  test("an entry, with what it maps and where its webhooks go", () => {
    expect(formatSource(source, "https://vibe.example.com/")).toBe(
      [
        "slack  slack  via support  ·  active  ·  2 on the way out  ·  1 not delivered",
        "  #errors  <->  #errors-www",
        "  webhooks: https://vibe.example.com/v1/sync/webhooks/src_1",
        "  sends to: https://slack.com/api",
      ].join("\n"),
    );
  });

  test("where a thread is synced, and a failure under the message it was of", () => {
    const target = {
      source: "slack",
      platform: "slack" as const,
      target: "slack:C1:1700000000.000100",
      state: "synced" as const,
      url: "https://acme.slack.com/archives/C1/p1700000000000100",
      copy: null,
    };
    expect(formatSynced({ targets: [], failures: [] })).toBe("This thread is on the vibe only.");
    expect(formatSynced({ targets: [target], failures: [] })).toBe(
      "slack:C1:1700000000.000100  synced  https://acme.slack.com/archives/C1/p1700000000000100",
    );

    const by = {
      actor: "vibe:user:u_1",
      handle: "ada",
      name: "Ada",
      principal: "vibe:user:u_1",
      profile: null,
    };
    const message = {
      id: "msg_1",
      channel: "dev",
      text: "checkout is down",
      re: null,
      replyTo: null,
      by,
      from: "vibe",
      noSync: false,
      attachments: [],
      blocks: [],
      labels: {},
      mentions: [],
      reactions: [],
      revision: 1,
      deletedAt: null,
      createdAt: new Date().toISOString(),
    };
    const reply = { ...message, id: "msg_2", re: "msg_1", text: "from slack", from: "slack" };
    const failure = {
      message: "msg_1",
      source: "slack",
      target: target.target,
      error: "Slack refused chat.postMessage: channel_not_found.",
      at: new Date().toISOString(),
    };
    const printed = formatThread({
      message,
      replies: [reply],
      task: null,
      schedules: [],
      sync: { targets: [target], failures: [failure] },
      cursor: "cur_1",
    });
    expect(printed).toContain(
      "  ! not delivered to slack:C1:1700000000.000100: Slack refused chat.postMessage: channel_not_found.",
    );
    expect(printed).toContain("  synced with slack:C1:1700000000.000100");
    expect(printed).toContain("msg_2  ada  from slack  ");
  });
});
