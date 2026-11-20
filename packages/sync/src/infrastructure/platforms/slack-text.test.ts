import { describe, expect, test } from "bun:test";

import { USER_MENTION, userMention, withoutMarks } from "../../application/platform.ts";
import { fromMrkdwn, fromSlackEmoji, quietForSlack, toSlackEmoji } from "./slack-text.ts";

describe("Slack's formatting, read as Markdown", () => {
  test("bold and strikethrough take Markdown's spelling", () => {
    expect(fromMrkdwn("*deploys* are ~red~ green, _really_")).toBe(
      "**deploys** are ~~red~~ green, _really_",
    );
    // A star that isn't formatting stays a star.
    expect(fromMrkdwn("2 * 3 * 4 and a*b*c")).toBe("2 * 3 * 4 and a*b*c");
  });

  test("links, channels and notices are written out", () => {
    expect(fromMrkdwn("see <https://example.com/a?b=1|the trace> or <https://example.com>")).toBe(
      "see [the trace](https://example.com/a?b=1) or https://example.com",
    );
    expect(fromMrkdwn("in <#C123|errors-www>, cc <!here> and <!subteam^S1|@oncall>")).toBe(
      // A notice is written so that it is nobody's handle here.
      "in #errors-www, cc @\u200bhere and @\u200boncall",
    );
    expect(fromMrkdwn("mail <mailto:ada@example.com|ada@example.com>")).toBe(
      "mail ada@example.com",
    );
  });

  test("a mention of a user is left for whoever brings the message in", () => {
    expect(fromMrkdwn("<@U0456> can you look? thanks <@W999|grace>")).toBe(
      `${userMention("U0456")} can you look? thanks ${userMention("W999")}`,
    );
    // What someone typed is not one, whatever it spells.
    expect([...fromMrkdwn("@[user:U0456] and @[vibe:user:u_1]").matchAll(USER_MENTION)]).toEqual(
      [],
    );
  });

  test("what is written here pages no one in Slack by itself", () => {
    expect(
      quietForSlack("<!channel> <!here> <@U0VICTIM> @channel @here, see <https://x.test>"),
    ).toBe(
      "<\u200b!channel> <\u200b!here> <\u200b@U0VICTIM> @\u200bchannel @\u200bhere, see <https://x.test>",
    );
  });

  test("a webhook can't carry the marks a mention is written with", () => {
    const forged = JSON.stringify({ text: userMention("U0456") });
    expect(withoutMarks(forged)).toBe('{"text":"U0456"}');
    expect(withoutMarks('{"text":"\\ue000U0456\\uE001"}')).toBe('{"text":"U0456"}');
  });

  test("escapes are undone, and code is left as it was written", () => {
    expect(fromMrkdwn("a &lt; b &amp;&amp; c &gt; d")).toBe("a < b && c > d");
    expect(fromMrkdwn("run `rm *.log` then ```x = *p;\n<tag>```")).toBe(
      "run `rm *.log` then ```x = *p;\n<tag>```",
    );
  });
});

describe("reactions", () => {
  test("go by Slack's names there and Vibe's here", () => {
    expect(toSlackEmoji("thumbs_up")).toBe("thumbsup");
    expect(toSlackEmoji("eyes")).toBe("eyes");
    expect(toSlackEmoji("🦄")).toBeNull();
    expect(fromSlackEmoji("thumbsup::skin-tone-3")).toBe("thumbs_up");
    expect(fromSlackEmoji("white_check_mark")).toBe("white_check_mark");
  });
});
