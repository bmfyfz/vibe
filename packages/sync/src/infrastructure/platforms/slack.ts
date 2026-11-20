import {
  type Identity,
  type InboundMessage,
  type MapInput,
  type Outgoing,
  type Platform,
  type PlatformContext,
  type RawWebhook,
  type Received,
  renderMentions,
  type Send,
  type Sent,
  type ThreadRef,
} from "../../application/platform.ts";
import { PlatformError } from "../../domain/delivery.ts";
import { invalidSource, invalidTarget, webhookRefused } from "../../domain/errors.ts";
import type { PlatformUser } from "../../domain/platform-user.ts";
import { verifyHmacHex } from "../../domain/signature.ts";
import {
  type Credentials,
  type Mapping,
  parseApiUrl,
  type Source,
  type SourceConfig,
} from "../../domain/source.ts";
import type { Place } from "../../domain/target.ts";
import { jsonOf, parseBody, record, records, request, retryAfterMs, text } from "./http.ts";
import { fromMrkdwn, fromSlackEmoji, quietForSlack, toSlackEmoji } from "./slack-text.ts";

const API = "https://slack.com/api";
// Slack's own figure: a request older than five minutes may be a replay.
const MAX_AGE_SECONDS = 5 * 60;
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;
const TIMESTAMP = /^\d{1,12}\.\d{1,9}$/;
// Channels are listed a thousand at a time, and a workspace is searched this far for a name.
const MAX_PAGES = 10;
// The message subtypes that are a person or an app saying something.
const SPOKEN = [undefined, "bot_message", "file_share", "thread_broadcast", "me_message"];

type Arguments = Record<string, string | undefined>;

/**
 * Slack, through its Web API and Events API.
 *
 * A thread is `<channel>:<ts of its first message>` and a message is
 * `<channel>:<ts>`, since a `ts` is unique only within its channel. The
 * entry's own posts come back as events like anyone's, and are told apart by
 * the bot they are from.
 */
export class SlackPlatform implements Platform {
  readonly kind = "slack";
  readonly startsThreads = true;
  readonly handlesMention = true;

  async identify(input: { credentials: Credentials; api: string; send: Send }): Promise<Identity> {
    const { credentials, api, send } = input;
    if (credentials.token === null) {
      throw invalidSource(
        "Slack needs the app's bot token.",
        "It starts with xoxb-, under OAuth & Permissions in the app's settings.",
      );
    }
    const { body, headers } = await call(send, api, credentials.token, "auth.test", {});
    const user = text(body["user_id"]);
    if (user === null) throw invalidSource("Slack didn't say who this token is.");
    const scopes = (headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim());
    return {
      self: {
        user,
        bot: text(body["bot_id"]) ?? "",
        team: text(body["team_id"]) ?? "",
        url: text(body["url"]) ?? "",
      },
      // Posting under an author's name is a permission the app may not have.
      customize: scopes.includes("chat:write.customize"),
    };
  }

  async connect(input: {
    credentials: Credentials;
    map: Readonly<Record<string, MapInput>>;
    api: string | undefined;
    send: Send;
  }): Promise<SourceConfig> {
    const { credentials, send } = input;
    const api = parseApiUrl(input.api, API);
    const identity = await this.identify({ credentials, api, send });
    const token = credentials.token ?? "";

    let listed: Map<string, string> | null = null;
    const mappings: Mapping[] = [];
    for (const [named, to] of Object.entries(input.map)) {
      const channel = typeof to === "string" ? to : to.channel;
      if (
        channel === undefined ||
        (typeof to !== "string" && (to.pulls ?? to.issues ?? to.replies) !== undefined)
      ) {
        throw invalidSource(`${named} maps to one vibe channel, such as "#errors": "errors-www".`);
      }
      const name = named.trim();
      if (CHANNEL_ID.test(name)) {
        mappings.push({ platform: name, label: name, channel, out: true });
        continue;
      }
      listed ??= await channelsByName(send, api, token);
      const id = listed.get(name.replace(/^#/, "").toLowerCase());
      if (id === undefined) {
        throw invalidSource(
          `Slack shows this app no public channel named ${name}.`,
          "Map a private channel by its ID, such as C0123ABC, and invite the app to it.",
        );
      }
      mappings.push({ platform: id, label: `#${name.replace(/^#/, "")}`, channel, out: true });
    }
    return { mappings, api, ...identity };
  }

  async verify(webhook: RawWebhook, credentials: Credentials, now: number): Promise<void> {
    const signature = webhook.headers.get("x-slack-signature") ?? "";
    const timestamp = webhook.headers.get("x-slack-request-timestamp") ?? "";
    if (!signature.startsWith("v0=") || !/^\d{1,12}$/.test(timestamp)) {
      throw webhookRefused("This request carries no Slack signature.");
    }
    // The timestamp is signed, so an old request can't be passed off as new.
    if (Math.abs(now / 1000 - Number(timestamp)) > MAX_AGE_SECONDS) {
      throw webhookRefused("This request's signature is too old.");
    }
    const signed = `v0:${timestamp}:${webhook.body}`;
    if (!(await verifyHmacHex(credentials.secret, signed, signature.slice(3)))) {
      throw webhookRefused("This request's signature is not Slack's for this app.");
    }
  }

  read(webhook: RawWebhook, source: Source): Received {
    const body = parseBody(webhook.body);
    if (body["type"] === "url_verification") {
      // Slack asks this once, when the URL is set, to see that it is answered.
      return {
        deliveryId: `challenge:${text(body["challenge"]) ?? ""}`.slice(0, 200),
        event: "url_verification",
        answer: { body: text(body["challenge"]) ?? "", contentType: "text/plain" },
        changes: [],
      };
    }
    const event = record(body["event"]);
    const type = text(event["type"]) ?? "unknown";
    const subtype = text(event["subtype"]);
    const received = {
      deliveryId: text(body["event_id"]) ?? `${type}:${text(event["event_ts"]) ?? "?"}`,
      event: subtype === null ? type : `${type}.${subtype}`,
    };
    const { self } = source.config;
    const ours = (from: Record<string, unknown>) =>
      (self["bot"] !== "" && from["bot_id"] === self["bot"]) || from["user"] === self["user"];
    const none = (note: string): Received => ({ ...received, changes: [], note });

    if (body["type"] !== "event_callback") return none("Not an event.");
    const channel = text(event["channel"]) ?? text(record(event["item"])["channel"]);
    if (channel === null) return none("It names no channel.");

    if (type === "reaction_added" || type === "reaction_removed") {
      const item = record(event["item"]);
      const ts = text(item["ts"]);
      const user = text(event["user"]);
      if (item["type"] !== "message" || ts === null || user === null) {
        return none("A reaction to something that isn't a message.");
      }
      if (ours(event)) return none("The entry's own reaction.");
      return {
        ...received,
        changes: [
          {
            kind: "reaction",
            message: `${channel}:${ts}`,
            author: { id: user, name: null },
            emoji: fromSlackEmoji(text(event["reaction"]) ?? ""),
            remove: type === "reaction_removed",
          },
        ],
      };
    }
    if (type !== "message") return none("Not a kind of event that syncs.");

    if (subtype === "message_changed") {
      const changed = record(event["message"]);
      const ts = text(changed["ts"]);
      if (ts === null) return none("It names no message.");
      if (ours(changed)) return none("The entry's own message.");
      return {
        ...received,
        changes: [{ kind: "edit", message: `${channel}:${ts}`, text: textOf(changed) }],
      };
    }
    if (subtype === "message_deleted") {
      const ts = text(event["deleted_ts"]);
      if (ts === null) return none("It names no message.");
      if (ours(record(event["previous_message"]))) return none("The entry's own message.");
      return { ...received, changes: [{ kind: "delete", message: `${channel}:${ts}` }] };
    }
    if (!SPOKEN.includes(subtype ?? undefined)) return none("A notice, not a message.");
    if (ours(event)) return none("The entry's own message.");
    const message = spoken(channel, event, self["url"] ?? "");
    return message ? { ...received, changes: [message] } : none("It names no message.");
  }

  sends(): boolean {
    return true;
  }

  async place(context: PlatformContext, rest: string): Promise<Place> {
    const { source, credentials, send } = context;
    // `C0123ABC:1700000000.000100` is a thread, by its channel and its first message.
    const [first = "", ts] = rest.split(":");
    const named = first.trim();
    let channel: string | undefined;
    if (CHANNEL_ID.test(named)) channel = named;
    else {
      const label = `#${named.replace(/^#/, "").toLowerCase()}`;
      channel = source.config.mappings.find(
        (mapping) => mapping.label.toLowerCase() === label,
      )?.platform;
      if (channel === undefined && credentials.token !== null) {
        const listed = await channelsByName(send, source.config.api, credentials.token);
        channel = listed.get(label.slice(1));
      }
    }
    if (channel === undefined) {
      throw invalidTarget(
        `Slack shows this app no public channel named ${named}.`,
        "Name a private channel by its ID, such as slack:C0123ABC.",
      );
    }
    if (ts === undefined) return { channel, thread: null, url: null };
    if (!TIMESTAMP.test(ts)) {
      throw invalidTarget(
        `"${ts}" is not a Slack message's timestamp.`,
        "A thread is its channel's ID and its first message's ts, such as slack:C0123ABC:1700000000.000100.",
      );
    }
    return {
      channel,
      thread: `${channel}:${ts}`,
      url: permalink(source.config.self["url"] ?? "", channel, ts, null),
    };
  }

  async describe(context: PlatformContext, userId: string): Promise<PlatformUser> {
    const { body } = await this.call(context, "users.info", { user: userId });
    const user = record(body["user"]);
    const profile = record(user["profile"]);
    const name =
      text(profile["display_name"]) ?? text(profile["real_name"]) ?? text(user["real_name"]);
    return { id: userId, name: name ?? text(user["name"]) };
  }

  async root(
    context: PlatformContext,
    channel: string,
    thread: string,
  ): Promise<InboundMessage | null> {
    const ts = thread.slice(channel.length + 1);
    const { body } = await this.call(context, "conversations.replies", {
      channel,
      ts,
      limit: "1",
      inclusive: "true",
    });
    const [first] = records(body["messages"]);
    if (!first || first["ts"] !== ts) return null;
    return spoken(channel, first, context.source.config.self["url"] ?? "");
  }

  async start(
    context: PlatformContext,
    channel: string,
    message: Outgoing,
  ): Promise<Sent & ThreadRef> {
    const sent = await this.post(context, channel, null, message);
    return { ...sent, channel, thread: sent.message };
  }

  reply(context: PlatformContext, thread: ThreadRef, message: Outgoing): Promise<Sent> {
    return this.post(context, thread.channel, tsOf(thread.thread), message);
  }

  async edit(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
    message: Outgoing,
  ): Promise<void> {
    await this.call(context, "chat.update", {
      channel: thread.channel,
      ts: tsOf(platformMessage),
      markdown_text: this.written(context, message),
    });
  }

  async remove(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
  ): Promise<void> {
    await this.call(context, "chat.delete", { channel: thread.channel, ts: tsOf(platformMessage) });
  }

  async react(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
    emoji: string,
    remove: boolean,
  ): Promise<void> {
    const name = toSlackEmoji(emoji);
    if (name === null) return;
    try {
      await this.call(context, remove ? "reactions.remove" : "reactions.add", {
        channel: thread.channel,
        timestamp: tsOf(platformMessage),
        name,
      });
    } catch (error) {
      // Already as asked: someone else on the vibe reacted the same way first.
      const settled =
        error instanceof PlatformError && /already_reacted|no_reaction/.test(error.message);
      if (!settled) throw error;
    }
  }

  private async post(
    context: PlatformContext,
    channel: string,
    threadTs: string | null,
    message: Outgoing,
  ): Promise<Sent> {
    const { config } = context.source;
    const { body } = await this.call(context, "chat.postMessage", {
      channel,
      thread_ts: threadTs ?? undefined,
      markdown_text: this.written(context, message),
      // Under its author's name, where the app may. Otherwise the name leads the text.
      username: config.customize ? message.author.slice(0, 80) : undefined,
      unfurl_links: "false",
    });
    const ts = text(body["ts"]);
    if (ts === null)
      throw new PlatformError("Slack accepted the message and gave it no timestamp.");
    return {
      message: `${channel}:${ts}`,
      url: permalink(config.self["url"] ?? "", channel, ts, threadTs),
    };
  }

  /** A vibe message as Slack is given it: Markdown, with Slack's own mentions. */
  private written(context: PlatformContext, message: Outgoing): string {
    const body = renderMentions(message, (user) => `<@${user}>`, quietForSlack);
    const files = message.files.map((name) => `_attached on Vibe: ${name}_`);
    const lead = context.source.config.customize ? [] : [`**${message.author}:**`];
    return [[...lead, body].filter((part) => part !== "").join(" "), ...files]
      .filter((part) => part !== "")
      .join("\n\n");
  }

  private call(context: PlatformContext, method: string, args: Arguments) {
    const { source, credentials, send } = context;
    return call(send, source.config.api, credentials.token ?? "", method, args);
  }
}

/** The message a Slack `message` object is, or `null` when it lacks what one needs. */
function spoken(
  channel: string,
  event: Record<string, unknown>,
  workspace: string,
): InboundMessage | null {
  const ts = text(event["ts"]);
  const author = authorOf(event);
  if (ts === null || author === null) return null;
  const threadTs = text(event["thread_ts"]) ?? ts;
  return {
    kind: "message",
    channel,
    thread: `${channel}:${threadTs}`,
    message: `${channel}:${ts}`,
    root: threadTs === ts,
    author,
    text: textOf(event),
    url: permalink(workspace, channel, ts, threadTs === ts ? null : threadTs),
  };
}

/** Who wrote a Slack message: a person, or another app's bot, which syncs like anyone. */
function authorOf(event: Record<string, unknown>): PlatformUser | null {
  const user = text(event["user"]);
  if (user !== null) return { id: user, name: null };
  const bot = text(event["bot_id"]);
  if (bot === null) return null;
  const name = text(event["username"]) ?? text(record(event["bot_profile"])["name"]);
  return { id: bot, name: name ?? "bot" };
}

/** A Slack message's text as Markdown, with a line for each file it carries. */
function textOf(message: Record<string, unknown>): string {
  const body = fromMrkdwn(text(message["text"]) ?? "");
  const files = records(message["files"]).map((file) => {
    const name = (text(file["title"]) ?? text(file["name"]) ?? "file").replaceAll("]", "");
    const link = text(file["permalink"]);
    return link === null ? `_file: ${name}_` : `[${name}](${link})`;
  });
  return [body, ...files].filter((part) => part.trim() !== "").join("\n\n");
}

const tsOf = (key: string) => key.slice(key.indexOf(":") + 1);

/** Slack's link to a message, as Slack itself spells it. `null` without the workspace's URL. */
function permalink(
  workspace: string,
  channel: string,
  ts: string,
  threadTs: string | null,
): string | null {
  if (workspace === "") return null;
  const base = `${workspace.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs === null ? base : `${base}?thread_ts=${threadTs}&cid=${channel}`;
}

/** One call to Slack's Web API. Its arguments go as a form, which every method takes. */
// Slack's refusals that a later attempt would meet again.
const PERMANENT = new Set([
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "msg_too_long",
  "thread_not_found",
]);

async function call(
  send: Send,
  api: string,
  token: string,
  method: string,
  args: Arguments,
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(args)) {
    if (value !== undefined) form.set(name, value);
  }
  const response = await request(send, `${api}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: form.toString(),
  });
  const body = await jsonOf(response);
  // Slack answers 200 with `ok: false` for a call it refuses, and 429 when asked too often.
  if (body?.["ok"] === true) return { body, headers: response.headers };
  const said = text(body?.["error"]) ?? `HTTP ${response.status}`;
  throw new PlatformError(
    `Slack refused ${method}: ${said}.`,
    retryAfterMs(response),
    PERMANENT.has(said),
  );
}

/** The workspace's public channels that the app can see, by name. */
async function channelsByName(
  send: Send,
  api: string,
  token: string,
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { body } = await call(send, api, token, "conversations.list", {
      types: "public_channel",
      exclude_archived: "true",
      limit: "1000",
      cursor,
    });
    for (const channel of records(body["channels"])) {
      const id = text(channel["id"]);
      const name = text(channel["name"]);
      if (id !== null && name !== null) byName.set(name.toLowerCase(), id);
    }
    cursor = text(record(body["response_metadata"])["next_cursor"]) ?? undefined;
    if (cursor === undefined) break;
  }
  return byName;
}
