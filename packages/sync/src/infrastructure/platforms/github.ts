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

const API = "https://api.github.com";
// The REST API version these calls were written against.
const API_VERSION = "2026-03-10";
const REPOSITORY = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

// What a pull request's or an issue's own state decides among a root's
// labels. `review` is decided by reviews, which arrive on their own.
const OWNED = ["state", "head", "tag.", "assignee."];

/**
 * What marks a comment as a copy of a vibe message. It is in the comment
 * itself, so the comment's own webhook is known for an echo however early it
 * arrives, and whoever's token wrote it.
 */
const MARK = /<!-- vibe:(msg_[0-9a-z]+) -->/;

/**
 * GitHub, through repository webhooks and its REST API.
 *
 * A thread is `owner/repo#number`, for a pull request and for an issue alike.
 * A comment is `ic:<id>`, a review `rv:<id>` and a review comment `rc:<id>`,
 * since the three are numbered apart.
 *
 * Pull requests and issues come in, with their state as the root's labels.
 * Nothing goes back unless a repository's mapping says replies do, and then
 * only replies that were written on the vibe: a repository is often public,
 * and what was said elsewhere may not be.
 */
export class GitHubPlatform implements Platform {
  readonly kind = "github";
  /** A new thread on the vibe never opens an issue or a pull request. */
  readonly startsThreads = false;
  readonly handlesMention = false;

  async identify(input: { credentials: Credentials; api: string; send: Send }): Promise<Identity> {
    const { credentials, api, send } = input;
    const self: Record<string, string> = {};
    if (credentials.token !== null) {
      // Asking who the token is proves it works before anything relies on it.
      const body = await call(send, api, credentials.token, "GET", "/user");
      self["login"] = text(body["login"]) ?? "";
      self["id"] = String(body["id"] ?? "");
    }
    return { self, customize: false };
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

    const mappings: Mapping[] = [];
    for (const [named, to] of Object.entries(input.map)) {
      const repository = named.trim().toLowerCase();
      if (!REPOSITORY.test(repository)) {
        throw invalidSource(
          `"${named}" is not a repository.`,
          "Name it as owner/repo, such as acme/www.",
        );
      }
      const entry = typeof to === "string" ? { channel: to } : to;
      const out = entry.replies === true;
      if (out && credentials.token === null) {
        throw invalidSource(
          `Sending replies back to ${repository} takes a token.`,
          "Give the entry a token that can write issues and pull requests there, or leave `replies` out.",
        );
      }
      const row = { platform: repository, label: repository, out };
      if (entry.channel !== undefined) {
        if (entry.pulls !== undefined || entry.issues !== undefined) {
          throw invalidSource(
            `${repository} maps to one channel, or to one each for pulls and issues.`,
          );
        }
        mappings.push({ ...row, channel: entry.channel });
        continue;
      }
      if (entry.pulls === undefined && entry.issues === undefined) {
        throw invalidSource(`${repository} is mapped to no channel.`);
      }
      if (entry.pulls !== undefined) mappings.push({ ...row, channel: entry.pulls, only: "pulls" });
      if (entry.issues !== undefined) {
        mappings.push({ ...row, channel: entry.issues, only: "issues" });
      }
    }
    return { mappings, api, ...identity };
  }

  async verify(webhook: RawWebhook, credentials: Credentials): Promise<void> {
    const signature = webhook.headers.get("x-hub-signature-256") ?? "";
    if (!signature.startsWith("sha256=")) {
      throw webhookRefused("This request carries no GitHub signature.");
    }
    if (!(await verifyHmacHex(credentials.secret, webhook.body, signature.slice(7)))) {
      throw webhookRefused("This request's signature is not GitHub's for this webhook.");
    }
  }

  read(webhook: RawWebhook): Received {
    const body = parseBody(webhook.body);
    const kind = webhook.headers.get("x-github-event") ?? "unknown";
    const action = text(body["action"]);
    const received = {
      // GitHub signs the body and nothing else, so the signature is what
      // tells one delivery from another. The delivery ID is a header anyone
      // who kept a signed request could change, to have it taken as new.
      deliveryId:
        (webhook.headers.get("x-hub-signature-256") ?? "").slice(7) || crypto.randomUUID(),
      event: action === null ? kind : `${kind}.${action}`,
    };
    const none = (note: string): Received => ({ ...received, changes: [], note });

    if (kind === "ping") return none("A ping: the webhook reaches this entry.");
    const repository = text(record(body["repository"])["full_name"])?.toLowerCase() ?? null;
    if (repository === null) return none("It names no repository.");

    if (kind === "issues" || kind === "pull_request") {
      const subject = record(body[kind === "issues" ? "issue" : "pull_request"]);
      // GitHub sends an `issues` event for a pull request too, in places. The
      // pull request's own event says more, and is the one that counts.
      if (kind === "issues" && "pull_request" in subject) return none("A pull request's issue.");
      const root = rootOf(repository, subject, kind === "pull_request");
      if (root === null) return none("It names no issue or pull request.");
      const changes: Inbound[] = [root];
      if (action === "deleted") {
        changes.push({ kind: "delete", message: root.message });
        return { ...received, changes };
      }
      if (action === "edited")
        changes.push({ kind: "edit", message: root.message, text: root.text });
      changes.push({ kind: "state", thread: root.thread, labels: root.labels ?? {}, owned: OWNED });
      return { ...received, changes };
    }

    if (kind === "issue_comment") {
      const issue = record(body["issue"]);
      const root = rootOf(repository, issue, "pull_request" in issue);
      const comment = record(body["comment"]);
      if (root === null) return none("It names no issue or pull request.");
      return said(received, root, `ic:${comment["id"]}`, comment, action, textOf(comment));
    }

    const pull = rootOf(repository, record(body["pull_request"]), true);
    if (pull === null) return none("Not a kind of event that syncs.");

    if (kind === "pull_request_review_comment") {
      const comment = record(body["comment"]);
      const path = text(comment["path"]);
      const where = path === null ? "" : `\n\n_on \`${path}\`_`;
      return said(received, pull, `rc:${comment["id"]}`, comment, action, textOf(comment) + where);
    }

    if (kind === "pull_request_review") {
      const review = record(body["review"]);
      const state = text(review["state"])?.toLowerCase() ?? "";
      const id = `rv:${review["id"]}`;
      const verdict = VERDICTS[state];
      const written = [verdict ? `**${verdict}**` : null, text(review["body"])].filter(Boolean);
      const changes: Inbound[] = [pull];
      if (action === "submitted" && written.length > 0) {
        changes.push(comment(pull, id, review, written.join("\n\n")));
      } else if (action === "edited") {
        changes.push({ kind: "edit", message: id, text: written.join("\n\n") });
      }
      // A review's verdict is the thread's `review` label, until it is dismissed.
      const labels = new PlatformLabels();
      if (action !== "dismissed" && (state === "approved" || state === "changes_requested")) {
        labels.set("review", state);
      }
      if (action === "dismissed" || labels.all["review"] !== undefined) {
        changes.push({ kind: "state", thread: pull.thread, labels: labels.all, owned: ["review"] });
      }
      return { ...received, changes };
    }
    return none("Not a kind of event that syncs.");
  }

  /** Only replies written on the vibe go back, and only where the repository's mapping says so. */
  sends(mapping: Mapping | null, message: { root: boolean; from: string }): boolean {
    return mapping?.out === true && !message.root && message.from === "vibe";
  }

  async place(_context: PlatformContext, rest: string): Promise<Place> {
    // `acme/www:123` and `acme/www#123` both name a pull request or an issue.
    const match = /^([^\s:#]+\/[^\s:#]+)[:#](\d{1,10})$/.exec(rest.trim().toLowerCase());
    const repository = match?.[1];
    if (!match || repository === undefined || !REPOSITORY.test(repository)) {
      throw invalidTarget(
        `"${rest}" is not a pull request or an issue.`,
        "Name one as owner/repo:number, such as github:acme/www:123. A thread on the vibe never opens one.",
      );
    }
    return {
      channel: repository,
      thread: `${repository}#${match[2]}`,
      url: `https://github.com/${repository}/issues/${match[2]}`,
    };
  }

  start(): Promise<Sent & ThreadRef> {
    throw new PlatformError("A thread on the vibe never opens an issue or a pull request.");
  }

  async reply(context: PlatformContext, thread: ThreadRef, message: Outgoing): Promise<Sent> {
    const [repository = "", number = ""] = thread.thread.split("#");
    const body = await this.call(
      context,
      "POST",
      `/repos/${repository}/issues/${number}/comments`,
      {
        body: written(message),
      },
    );
    return { message: `ic:${body["id"]}`, url: text(body["html_url"]) };
  }

  async edit(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
    message: Outgoing,
  ): Promise<void> {
    if (!platformMessage.startsWith("ic:")) return;
    const path = `/repos/${thread.channel}/issues/comments/${platformMessage.slice(3)}`;
    await this.call(context, "PATCH", path, { body: written(message) });
  }

  async remove(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
  ): Promise<void> {
    if (!platformMessage.startsWith("ic:")) return;
    const path = `/repos/${thread.channel}/issues/comments/${platformMessage.slice(3)}`;
    await this.call(context, "DELETE", path);
  }

  private call(context: PlatformContext, method: string, path: string, body?: unknown) {
    const { source, credentials, send } = context;
    if (credentials.token === null) throw new PlatformError("This entry has no GitHub token.");
    return call(send, source.config.api, credentials.token, method, path, body);
  }
}

const VERDICTS: Record<string, string> = {
  approved: "Approved",
  changes_requested: "Requested changes",
};

/** A comment's event as what it changes: the thread it is in, then the comment. */
function said(
  received: { deliveryId: string; event: string },
  root: InboundMessage,
  id: string,
  from: Record<string, unknown>,
  action: string | null,
  body: string,
): Received {
  // A copy of a vibe message carries its mark. It is not news here.
  if (MARK.test(text(from["body"]) ?? "")) {
    return { ...received, changes: [], note: "The entry's own comment." };
  }
  const changes: Inbound[] = [root];
  if (action === "created") changes.push(comment(root, id, from, body));
  else if (action === "edited") changes.push({ kind: "edit", message: id, text: body });
  else if (action === "deleted") changes.push({ kind: "delete", message: id });
  return { ...received, changes };
}

function comment(
  root: InboundMessage,
  id: string,
  from: Record<string, unknown>,
  body: string,
): InboundMessage {
  return {
    kind: "message",
    channel: root.channel,
    ...(root.only === undefined ? {} : { only: root.only }),
    thread: root.thread,
    message: id,
    root: false,
    author: userOf(record(from["user"])),
    text: body,
    url: text(from["html_url"]),
  };
}

/**
 * A pull request or an issue as its thread's first message, with its state
 * as labels. Every event about one carries it whole, so a thread that isn't
 * here yet comes in from whichever event arrives first.
 */
function rootOf(
  repository: string,
  subject: Record<string, unknown>,
  pull: boolean,
): InboundMessage | null {
  const number = subject["number"];
  if (typeof number !== "number") return null;
  const thread = `${repository}#${number}`;
  const labels = new PlatformLabels()
    .set(pull ? "pr" : "issue", thread)
    .each(
      "tag",
      records(subject["labels"]).map((label) => text(label["name"])),
    )
    .each(
      "assignee",
      records(subject["assignees"]).map((assignee) => text(assignee["login"])),
    );
  const open = subject["state"] === "open";
  if (pull && "merged" in subject) {
    // A pull request's own event. An issue's event about one says less.
    const state = subject["merged"] === true ? "merged" : open ? "open" : "closed";
    labels.set("state", open && subject["draft"] === true ? "draft" : state);
    labels.set("head", text(record(subject["head"])["sha"]));
  } else {
    labels.set("state", open ? "open" : "closed");
  }
  const title = text(subject["title"]) ?? thread;
  return {
    kind: "message",
    channel: repository,
    only: pull ? "pulls" : "issues",
    thread,
    message: thread,
    root: true,
    author: userOf(record(subject["user"])),
    text: [`**${title}**`, textOf(subject)].filter((part) => part !== "").join("\n\n"),
    url: text(subject["html_url"]),
    labels: labels.all,
  };
}

function userOf(user: Record<string, unknown>): PlatformUser {
  const login = text(user["login"]) ?? "ghost";
  return { id: String(user["id"] ?? login), name: login, login };
}

/**
 * A body as a vibe message holds it. A mention there is left as text: it
 * names a GitHub login, and whoever brings the message in settles no handle
 * in it, so it pages no one here.
 */
function textOf(from: Record<string, unknown>): string {
  return (text(from["body"]) ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * A vibe message's prose with no `@login` or `@org/team` that GitHub would
 * notify: an invisible space after the `@` breaks each. Only the people this
 * entry brought in are mentioned, by `renderMentions`.
 */
function quietForGitHub(prose: string): string {
  return prose.replace(/(?<![\w@])@(?=[a-z0-9])/gi, "@\u200b");
}

/** A vibe message as a comment: who wrote it, what they wrote, and the mark that it is a copy. */
function written(message: Outgoing): string {
  const body = renderMentions(message, (_id, login) => `@${login}`, quietForGitHub);
  const files = message.files.map((name) => `_attached on Vibe: ${name}_`);
  return [`**${message.author}** wrote:`, body, ...files, `<!-- vibe:${message.id} -->`]
    .filter((part) => part !== "")
    .join("\n\n");
}

/** One call to GitHub's REST API. */
async function call(
  send: Send,
  api: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await request(send, `${api}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": API_VERSION,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return {};
  const answer = await jsonOf(response);
  if (response.ok && answer !== null) return answer;
  const said = text(answer?.["message"]) ?? `HTTP ${response.status}`;
  throw new PlatformError(
    `GitHub refused ${method} ${path}: ${said}.`,
    retryAfterMs(response),
    // Not there, gone, or a body GitHub won't take: the same answer next time.
    [404, 410, 422].includes(response.status),
  );
}
