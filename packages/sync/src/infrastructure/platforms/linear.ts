import {
  type Identity,
  type Inbound,
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
import { PlatformLabels } from "../../domain/labels.ts";
import type { PlatformUser } from "../../domain/platform-user.ts";
import { verifyHmacHex } from "../../domain/signature.ts";
import {
  type Credentials,
  type Mapping,
  parseApiUrl,
  type SourceConfig,
} from "../../domain/source.ts";
import type { Place } from "../../domain/target.ts";
import { jsonOf, parseBody, record, records, request, retryAfterMs, text } from "./http.ts";

const API = "https://api.linear.app/graphql";
// Linear's own figure: a webhook sent more than a minute ago may be a replay.
const MAX_AGE_MS = 60_000;
const TEAM_KEY = /^[A-Z][A-Z0-9]{0,9}$/;
const ISSUE = /^([A-Z][A-Z0-9]{0,9})-(\d{1,9})$/;
const MAX_TITLE = 200;

// What an issue's own state decides among its root's labels.
const OWNED = ["state", "priority", "project", "tag.", "assignee."];

const ISSUE_FIELDS = `
  id identifier title description url priorityLabel
  team { id key }
  state { type }
  creator { id name }
  assignee { name }
  project { name }
  labels { nodes { name } }`;

/**
 * Linear, through its GraphQL API and its webhooks.
 *
 * A thread is an issue, by its ID, and a channel is a team, by its ID. An
 * issue's first message is the issue itself, and its comments are replies.
 *
 * Linear takes the ID of what it is asked to create. So a copy's ID is on
 * record before the call that makes it, and the webhook Linear then sends
 * about it is known for an echo, whoever's key the entry holds.
 */
export class LinearPlatform implements Platform {
  readonly kind = "linear";
  readonly startsThreads = true;
  readonly handlesMention = true;

  async identify(input: { credentials: Credentials; api: string; send: Send }): Promise<Identity> {
    const viewer = await this.asked(input);
    return { self: { user: viewer.id }, customize: false };
  }

  /** Who the key is, and the teams it can see. */
  private async asked(input: {
    credentials: Credentials;
    api: string;
    send: Send;
  }): Promise<{ id: string; teams: Map<string, string> }> {
    const { credentials, api, send } = input;
    if (credentials.token === null) {
      throw invalidSource(
        "Linear needs an API key.",
        "Create one under Settings, Security & access, Personal API keys.",
      );
    }
    const data = await call(
      send,
      api,
      credentials.token,
      "query { viewer { id name } teams(first: 250) { nodes { id key name } } }",
    );
    const id = text(record(data["viewer"])["id"]);
    if (id === null) throw invalidSource("Linear didn't say who this key is.");
    const teams = new Map(
      records(record(data["teams"])["nodes"]).map((team) => [
        text(team["key"])?.toUpperCase() ?? "",
        text(team["id"]) ?? "",
      ]),
    );
    return { id, teams };
  }

  async connect(input: {
    credentials: Credentials;
    map: Readonly<Record<string, MapInput>>;
    api: string | undefined;
    send: Send;
  }): Promise<SourceConfig> {
    const api = parseApiUrl(input.api, API);
    const { id: viewer, teams } = await this.asked({ ...input, api });

    const mappings: Mapping[] = [];
    for (const [named, to] of Object.entries(input.map)) {
      const channel = typeof to === "string" ? to : to.channel;
      if (
        channel === undefined ||
        (typeof to !== "string" && (to.pulls ?? to.issues ?? to.replies) !== undefined)
      ) {
        throw invalidSource(`${named} maps to one vibe channel, such as "ENG": "dev".`);
      }
      const key = named.trim().toUpperCase();
      const id = teams.get(key);
      if (!TEAM_KEY.test(key) || id === undefined || id === "") {
        throw invalidSource(
          `Linear shows this key no team with the key ${named}.`,
          "A team's key is the prefix of its issues, such as ENG in ENG-123.",
        );
      }
      mappings.push({ platform: id, label: key, channel, out: true });
    }
    return { mappings, api, self: { user: viewer }, customize: false };
  }

  async verify(webhook: RawWebhook, credentials: Credentials, now: number): Promise<void> {
    const signature = webhook.headers.get("linear-signature") ?? "";
    if (signature === "") throw webhookRefused("This request carries no Linear signature.");
    if (!(await verifyHmacHex(credentials.secret, webhook.body, signature))) {
      throw webhookRefused("This request's signature is not Linear's for this webhook.");
    }
    // The time is in the body, which is what was signed.
    const sentAt = parseBody(webhook.body)["webhookTimestamp"];
    if (typeof sentAt !== "number" || Math.abs(now - sentAt) > MAX_AGE_MS) {
      throw webhookRefused("This request's signature is too old.");
    }
  }

  read(webhook: RawWebhook): Received {
    const body = parseBody(webhook.body);
    const type = text(body["type"]) ?? "unknown";
    const action = text(body["action"]) ?? "unknown";
    const data = record(body["data"]);
    const received = {
      // The signature, not the delivery header: only what is signed tells one delivery from another.
      deliveryId:
        webhook.headers.get("linear-signature") ??
        `${type}:${data["id"]}:${body["webhookTimestamp"]}`,
      event: `${type}.${action}`,
    };
    const none = (note: string): Received => ({ ...received, changes: [], note });
    // Whoever did it. For something made, that is who made it.
    const actor = userOf(record(body["actor"]));

    if (type === "Issue") {
      const root = rootOf(data, actor, text(body["url"]));
      if (root === null) return none("It names no issue.");
      if (action === "remove")
        return { ...received, changes: [{ kind: "delete", message: root.message }] };
      const changes: Inbound[] = [root];
      const before = record(body["updatedFrom"]);
      if (action === "update" && ("title" in before || "description" in before)) {
        changes.push({ kind: "edit", message: root.message, text: root.text });
      }
      changes.push({ kind: "state", thread: root.thread, labels: root.labels ?? {}, owned: OWNED });
      return { ...received, changes };
    }

    if (type === "Comment") {
      const id = text(data["id"]);
      const issue = text(data["issueId"]);
      if (id === null || issue === null) return none("A comment on something that isn't an issue.");
      const written = text(data["body"]) ?? "";
      if (action === "remove") return { ...received, changes: [{ kind: "delete", message: id }] };
      if (action === "update")
        return { ...received, changes: [{ kind: "edit", message: id, text: written }] };
      const team =
        text(record(record(data["issue"])["team"])["id"]) ?? text(record(data["issue"])["teamId"]);
      const author = userOf(record(data["user"]), text(data["userId"])) ?? actor;
      return {
        ...received,
        changes: [
          {
            kind: "message",
            // The channel is only asked about for a thread that isn't here yet.
            channel: team ?? "",
            thread: issue,
            message: id,
            root: false,
            author: author ?? { id: "unknown", name: "Someone" },
            text: written,
            url: text(body["url"]),
          },
        ],
      };
    }
    return none("Not a kind of event that syncs.");
  }

  sends(): boolean {
    return true;
  }

  async place(context: PlatformContext, rest: string): Promise<Place> {
    const named = rest.trim().toUpperCase();
    const { mappings } = context.source.config;
    if (ISSUE.test(named)) {
      // An issue is found by its identifier, such as ENG-123, wherever its team is.
      const data = await this.call(
        context,
        `query($id: String!) { issue(id: $id) { id url team { id } } }`,
        {
          id: named,
        },
      ).catch(() => ({}) as Record<string, unknown>);
      const issue = record(data["issue"]);
      const id = text(issue["id"]);
      const team = text(record(issue["team"])["id"]);
      if (id === null || team === null) {
        throw invalidTarget(`Linear shows this entry no issue ${named}.`);
      }
      return { channel: team, thread: id, url: text(issue["url"]) };
    }
    const team = mappings.find((mapping) => mapping.label === named)?.platform;
    if (team === undefined) {
      throw invalidTarget(
        `"${rest}" is not an issue, or a team this entry maps.`,
        "Name an issue, such as linear:ENG-123, or a mapped team's key, such as linear:ENG, to open one.",
      );
    }
    return { channel: team, thread: null, url: null };
  }

  /** An issue as its thread's first message, for a comment whose issue isn't here yet. */
  async root(
    context: PlatformContext,
    _channel: string,
    thread: string,
  ): Promise<InboundMessage | null> {
    const data = await this.call(
      context,
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id: thread },
    );
    const issue = record(data["issue"]);
    return rootOf(
      {
        ...issue,
        teamId: record(issue["team"])["id"],
        labels: records(record(issue["labels"])["nodes"]),
      },
      userOf(record(issue["creator"])),
      text(issue["url"]),
    );
  }

  mint(): string {
    return crypto.randomUUID();
  }

  async start(
    context: PlatformContext,
    channel: string,
    message: Outgoing,
  ): Promise<Sent & ThreadRef> {
    const written = renderMentions(message, plainly);
    // The first line is the title, and the whole message is the description.
    const first = written.split("\n").find((line) => line.trim() !== "") ?? "";
    const title =
      first
        .replace(/^[#>*\-\s]+/, "")
        .replace(/[*_`]/g, "")
        .trim() || "From Vibe";
    const data = await this.call(
      context,
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id url } } }`,
      {
        input: {
          ...(message.mint === null ? {} : { id: message.mint }),
          teamId: channel,
          title: title.slice(0, MAX_TITLE),
          description: described(message, written),
        },
      },
    );
    const issue = record(record(data["issueCreate"])["issue"]);
    const id = text(issue["id"]);
    if (id === null) throw new PlatformError("Linear created no issue.");
    return { channel, thread: id, message: id, url: text(issue["url"]) };
  }

  async reply(context: PlatformContext, thread: ThreadRef, message: Outgoing): Promise<Sent> {
    const data = await this.call(
      context,
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id url } } }`,
      {
        input: {
          ...(message.mint === null ? {} : { id: message.mint }),
          issueId: thread.thread,
          body: described(message, renderMentions(message, plainly)),
        },
      },
    );
    const comment = record(record(data["commentCreate"])["comment"]);
    const id = text(comment["id"]);
    if (id === null) throw new PlatformError("Linear created no comment.");
    return { message: id, url: text(comment["url"]) };
  }

  async edit(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
    message: Outgoing,
  ): Promise<void> {
    const body = described(message, renderMentions(message, plainly));
    if (platformMessage === thread.thread) {
      await this.call(
        context,
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success } }`,
        { id: platformMessage, input: { description: body } },
      );
      return;
    }
    await this.call(
      context,
      `mutation($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) { success } }`,
      { id: platformMessage, input: { body } },
    );
  }

  async remove(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
  ): Promise<void> {
    // A deleted root leaves its issue alone: an issue is more than its first message.
    if (platformMessage === thread.thread) return;
    await this.call(context, `mutation($id: String!) { commentDelete(id: $id) { success } }`, {
      id: platformMessage,
    });
  }

  private call(context: PlatformContext, query: string, variables: Record<string, unknown> = {}) {
    const { source, credentials, send } = context;
    return call(send, source.config.api, credentials.token ?? "", query, variables);
  }
}

/** How a mention of a Linear user is written back: by name. Linear's own mentions are not text. */
const plainly = (_id: string, name: string) => name;

/** A vibe message as Linear is given it: who wrote it, then what they wrote. */
function described(message: Outgoing, written: string): string {
  const files = message.files.map((name) => `_attached on Vibe: ${name}_`);
  return [`**${message.author}** wrote:`, written, ...files]
    .filter((part) => part !== "")
    .join("\n\n");
}

function userOf(
  user: Record<string, unknown>,
  fallbackId: string | null = null,
): PlatformUser | null {
  const id = text(user["id"]) ?? fallbackId;
  if (id === null) return null;
  return { id, name: text(user["name"]) };
}

/** An issue as its thread's first message, with its state as labels. */
function rootOf(
  issue: Record<string, unknown>,
  actor: PlatformUser | null,
  url: string | null,
): InboundMessage | null {
  const id = text(issue["id"]);
  const team = text(issue["teamId"]) ?? text(record(issue["team"])["id"]);
  if (id === null || team === null) return null;
  const identifier = text(issue["identifier"]) ?? id;
  const priority = text(issue["priorityLabel"])?.toLowerCase() ?? null;
  const labels = new PlatformLabels()
    .set("issue", identifier)
    // The workflow state's type: triage, backlog, unstarted, started, completed or canceled.
    .set("state", text(record(issue["state"])["type"]))
    .set("priority", priority === "no priority" ? null : priority)
    .set("project", text(record(issue["project"])["name"]))
    .each(
      "tag",
      records(issue["labels"]).map((label) => text(label["name"])),
    )
    .each("assignee", [text(record(issue["assignee"])["name"])]);
  const creator = userOf(record(issue["creator"]), text(issue["creatorId"]));
  const title = text(issue["title"]) ?? identifier;
  return {
    kind: "message",
    channel: team,
    thread: id,
    message: id,
    root: true,
    author: creator?.name ? creator : (actor ?? creator ?? { id: "unknown", name: "Someone" }),
    text: [`**${title}**`, text(issue["description"]) ?? ""]
      .filter((part) => part !== "")
      .join("\n\n"),
    url: text(issue["url"]) ?? url,
    labels: labels.all,
  };
}

/** One call to Linear's GraphQL API. */
async function call(
  send: Send,
  api: string,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await request(send, api, {
    method: "POST",
    headers: {
      // A personal API key goes as it is. An OAuth token is a bearer token.
      authorization: token.startsWith("lin_api_") ? token : `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const answer = await jsonOf(response);
  const [error] = records(answer?.["errors"]);
  // GraphQL answers 200 with `errors` for a call it refuses, in part or whole.
  if (response.ok && answer !== null && error === undefined) return record(answer["data"]);
  const said = text(error?.["message"]) ?? `HTTP ${response.status}`;
  throw new PlatformError(`Linear refused the call: ${said}.`, retryAfterMs(response));
}
