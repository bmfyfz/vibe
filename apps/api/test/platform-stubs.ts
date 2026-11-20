import { createHmac, randomUUID } from "node:crypto";

/** One call Vibe made to a platform's API, as the stub saw it. */
export interface PlatformCall {
  platform: "slack" | "github" | "linear";
  /** Slack's method, GitHub's `METHOD /path`, or the GraphQL operation Linear was asked for. */
  what: string;
  /** What it was called with: a form's fields, a JSON body, or a query's variables. */
  args: Record<string, unknown>;
  authorization: string | null;
  /** The HTTP status it was answered with. */
  status: number;
  /** Whether the stub accepted it. */
  ok: boolean;
}

interface Failing {
  left: number;
  /** Only calls whose `what` holds this. Every call, when left out. */
  matching?: string | undefined;
  status: number;
  retryAfter?: number | undefined;
}

const hmac = (secret: string, text: string) =>
  createHmac("sha256", secret).update(text).digest("hex");

/**
 * Slack, GitHub and Linear, as much of each as Vibe speaks, in memory. One
 * handler answers for all three, so the same stand-in can be the `fetch`
 * that an app in this process is given, and a server on the loopback that a
 * running Vibe is pointed at.
 *
 * What a platform would send on its own, a webhook, a test sends itself: each
 * platform here signs a payload the way the real one does, with a key the
 * test chose, and the test posts it.
 */
export function platformStubs(now: () => number = Date.now) {
  const calls: PlatformCall[] = [];
  const failing: Failing[] = [];
  let made = 0;
  const next = () => ++made;

  /** Answers, or fails as a test asked it to. */
  function answered(call: Omit<PlatformCall, "status" | "ok">, answer: () => Response): Response {
    const fail = failing.find(
      (each) => each.left > 0 && (each.matching === undefined || call.what.includes(each.matching)),
    );
    if (fail) {
      fail.left -= 1;
      calls.push({ ...call, status: fail.status, ok: false });
      const headers: Record<string, string> = {};
      if (fail.retryAfter !== undefined) headers["retry-after"] = String(fail.retryAfter);
      return Response.json(
        { ok: false, error: "stub_unavailable" },
        { status: fail.status, headers },
      );
    }
    const response = answer();
    calls.push({ ...call, status: response.status, ok: response.status < 400 });
    return response;
  }

  // ── Slack ──────────────────────────────────────────────────────────────────

  const slack = {
    signingSecret: `slack-signing-${randomUUID()}`,
    token: `xoxb-stub-${randomUUID()}`,
    /** What `auth.test` says of the token. */
    self: { user: "U0VIBEBOT", bot: "B0VIBEBOT", team: "T0STUB", url: "https://stub.slack.com/" },
    /** The scopes the app was installed with, as `auth.test` reports them in a header. */
    scopes: ["chat:write", "channels:history", "channels:read", "reactions:write", "users:read"],
    /** The workspace's public channels, by name. */
    channels: new Map<string, string>(),
    users: new Map<string, string>(),
    /** Messages by `channel:ts`, as the workspace would show them. */
    messages: new Map<
      string,
      { channel: string; ts: string; thread: string | null; text: string; username: string | null }
    >(),
    reactions: [] as { channel: string; ts: string; name: string }[],
    /** What the workspace holds that Vibe didn't write, for it to read back: by `channel:ts`. */
    history: new Map<string, Record<string, unknown>>(),

    /** A channel no other test has, with its ID. */
    channel(name: string): string {
      const id = `C${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
      slack.channels.set(name, id);
      return id;
    },
    user(name: string): string {
      const id = `U${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
      slack.users.set(id, name);
      return id;
    },
    /** A timestamp Slack would give a message now: unique, and in order. */
    ts(): string {
      return `${Math.floor(now() / 1000)}.${String(next()).padStart(6, "0")}`;
    },
    /** The messages Vibe posted in a channel, in order. */
    posted(channel: string) {
      return [...slack.messages.values()].filter((message) => message.channel === channel);
    },
    /** A request as Slack signs it. `at` is when it says it was sent, in seconds. */
    signed(body: unknown, options: { secret?: string; at?: number } = {}) {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      const at = options.at ?? Math.floor(now() / 1000);
      const signature = hmac(options.secret ?? slack.signingSecret, `v0:${at}:${text}`);
      return {
        body: text,
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": String(at),
          "x-slack-signature": `v0=${signature}`,
        },
      };
    },
    /** An Events API callback around one event. */
    event(event: Record<string, unknown>) {
      return {
        token: "deprecated-verification-token",
        team_id: slack.self.team,
        api_app_id: "A0STUB",
        type: "event_callback",
        event_id: `Ev${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`,
        event_time: Math.floor(now() / 1000),
        event,
      };
    },
    /** A person's message in a channel, or with `thread_ts` in a thread. */
    said(message: {
      channel: string;
      user: string;
      text: string;
      ts?: string;
      thread_ts?: string;
    }) {
      const ts = message.ts ?? slack.ts();
      return slack.event({ type: "message", channel_type: "channel", ...message, ts });
    },
  };

  function slackApi(method: string, request: Request, form: URLSearchParams): Response {
    const args = Object.fromEntries(form);
    const call = {
      platform: "slack" as const,
      what: method,
      args,
      authorization: request.headers.get("authorization"),
    };
    return answered(call, () => {
      if (call.authorization !== `Bearer ${slack.token}`) {
        return Response.json({ ok: false, error: "invalid_auth" });
      }
      const channel = form.get("channel") ?? "";
      switch (method) {
        case "auth.test":
          return Response.json(
            {
              ok: true,
              url: slack.self.url,
              team: "Stub",
              user: "vibe",
              team_id: slack.self.team,
              user_id: slack.self.user,
              bot_id: slack.self.bot,
            },
            { headers: { "x-oauth-scopes": slack.scopes.join(",") } },
          );
        case "conversations.list":
          return Response.json({
            ok: true,
            channels: [...slack.channels].map(([name, id]) => ({ id, name, is_channel: true })),
            response_metadata: { next_cursor: "" },
          });
        case "users.info": {
          const name = slack.users.get(form.get("user") ?? "");
          if (name === undefined) return Response.json({ ok: false, error: "user_not_found" });
          return Response.json({
            ok: true,
            user: {
              id: form.get("user"),
              name: name.toLowerCase(),
              real_name: name,
              profile: { display_name: name, real_name: name },
            },
          });
        }
        case "chat.postMessage": {
          const ts = slack.ts();
          slack.messages.set(`${channel}:${ts}`, {
            channel,
            ts,
            thread: form.get("thread_ts"),
            text: form.get("markdown_text") ?? form.get("text") ?? "",
            username: form.get("username"),
          });
          return Response.json({ ok: true, channel, ts, message: { ts, bot_id: slack.self.bot } });
        }
        case "chat.update": {
          const message = slack.messages.get(`${channel}:${form.get("ts")}`);
          if (!message) return Response.json({ ok: false, error: "message_not_found" });
          message.text = form.get("markdown_text") ?? "";
          return Response.json({ ok: true, channel, ts: message.ts });
        }
        case "chat.delete":
          if (!slack.messages.delete(`${channel}:${form.get("ts")}`)) {
            return Response.json({ ok: false, error: "message_not_found" });
          }
          return Response.json({ ok: true, channel, ts: form.get("ts") });
        case "reactions.add":
        case "reactions.remove": {
          const reaction = {
            channel,
            ts: form.get("timestamp") ?? "",
            name: form.get("name") ?? "",
          };
          const at = slack.reactions.findIndex(
            (each) =>
              each.channel === reaction.channel &&
              each.ts === reaction.ts &&
              each.name === reaction.name,
          );
          if (method === "reactions.add") {
            if (at !== -1) return Response.json({ ok: false, error: "already_reacted" });
            slack.reactions.push(reaction);
          } else {
            if (at === -1) return Response.json({ ok: false, error: "no_reaction" });
            slack.reactions.splice(at, 1);
          }
          return Response.json({ ok: true });
        }
        case "conversations.replies": {
          const root = slack.history.get(`${channel}:${form.get("ts")}`);
          return Response.json({ ok: true, messages: root ? [root] : [] });
        }
        default:
          return Response.json({ ok: false, error: "unknown_method" });
      }
    });
  }

  // ── GitHub ─────────────────────────────────────────────────────────────────

  const github = {
    webhookSecret: `github-webhook-${randomUUID()}`,
    token: `github_pat_stub_${randomUUID()}`,
    self: { login: "vibe-sync", id: 4100 },
    /** The comments Vibe wrote, by their ID. */
    comments: new Map<number, { repository: string; number: number; body: string }>(),
    /** A repository no other test has, as `owner/repo`. */
    repository(name: string): string {
      return `acme-${randomUUID().slice(0, 8)}/${name}`;
    },
    /** A delivery as GitHub signs it. */
    signed(event: string, payload: unknown, options: { secret?: string; delivery?: string } = {}) {
      const body = JSON.stringify(payload);
      return {
        body,
        headers: {
          "content-type": "application/json",
          "user-agent": "GitHub-Hookshot/stub",
          "x-github-event": event,
          "x-github-delivery": options.delivery ?? randomUUID(),
          "x-hub-signature-256": `sha256=${hmac(options.secret ?? github.webhookSecret, body)}`,
        },
      };
    },
    account(login: string, id = next() + 5000) {
      return { login, id, type: "User", html_url: `https://github.com/${login}` };
    },
    /** A pull request as GitHub's webhooks describe one. */
    pull(repository: string, number: number, fields: Record<string, unknown> = {}) {
      return {
        number,
        title: `Pull request ${number}`,
        body: "",
        state: "open",
        draft: false,
        merged: false,
        html_url: `https://github.com/${repository}/pull/${number}`,
        user: github.account("octocat", 583231),
        head: { sha: "a".repeat(40), ref: "feature" },
        labels: [],
        assignees: [],
        ...fields,
      };
    },
    issue(repository: string, number: number, fields: Record<string, unknown> = {}) {
      return {
        number,
        title: `Issue ${number}`,
        body: "",
        state: "open",
        html_url: `https://github.com/${repository}/issues/${number}`,
        user: github.account("octocat", 583231),
        labels: [],
        assignees: [],
        ...fields,
      };
    },
    /** The parts every repository event carries. */
    about(repository: string) {
      return {
        repository: { full_name: repository, name: repository.split("/")[1], private: false },
        sender: github.account("octocat", 583231),
      };
    },
  };

  async function githubApi(request: Request, path: string): Promise<Response> {
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? {}
        : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const call = {
      platform: "github" as const,
      what: `${request.method} ${path}`,
      args: body,
      authorization: request.headers.get("authorization"),
    };
    return answered(call, () => {
      if (call.authorization !== `Bearer ${github.token}`) {
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      if (request.method === "GET" && path === "/user") return Response.json(github.self);
      const created = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
      if (request.method === "POST" && created) {
        const id = next() + 9000;
        const [, repository = "", number = "0"] = created;
        github.comments.set(id, {
          repository,
          number: Number(number),
          body: String(body["body"] ?? ""),
        });
        return Response.json(
          {
            id,
            body: body["body"],
            html_url: `https://github.com/${repository}/issues/${number}#issuecomment-${id}`,
            user: github.self,
          },
          { status: 201 },
        );
      }
      const one = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
      const comment = one ? github.comments.get(Number(one[1])) : undefined;
      if (one && comment && request.method === "PATCH") {
        comment.body = String(body["body"] ?? "");
        return Response.json({ id: Number(one[1]), body: comment.body });
      }
      if (one && comment && request.method === "DELETE") {
        github.comments.delete(Number(one[1]));
        return new Response(null, { status: 204 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    });
  }

  // ── Linear ─────────────────────────────────────────────────────────────────

  const linear = {
    webhookSecret: `linear-webhook-${randomUUID()}`,
    token: `lin_api_stub${randomUUID().replaceAll("-", "")}`,
    viewer: { id: randomUUID(), name: "Vibe Sync" },
    /** Teams by key, with their IDs. */
    teams: new Map<string, string>(),
    issues: new Map<
      string,
      {
        id: string;
        identifier: string;
        teamId: string;
        title: string;
        description: string;
        url: string;
      }
    >(),
    comments: new Map<string, { id: string; issueId: string; body: string }>(),
    /** A team no other test has: its key and its ID. */
    team(): { key: string; id: string } {
      const key = `T${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
      const id = randomUUID();
      linear.teams.set(key, id);
      return { key, id };
    },
    /** A delivery as Linear signs it. `at` is when it says it was sent, in milliseconds. */
    signed(payload: Record<string, unknown>, options: { secret?: string; at?: number } = {}) {
      const body = JSON.stringify({
        ...payload,
        webhookTimestamp: options.at ?? now(),
        webhookId: "stub",
      });
      return {
        body,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "user-agent": "Linear-Webhook",
          "linear-delivery": randomUUID(),
          "linear-event": String(payload["type"] ?? ""),
          "linear-signature": hmac(options.secret ?? linear.webhookSecret, body),
        },
      };
    },
    /** An issue as Linear's webhooks describe one. */
    issue(team: { key: string; id: string }, number: number, fields: Record<string, unknown> = {}) {
      const id = randomUUID();
      const identifier = `${team.key}-${number}`;
      return {
        id,
        identifier,
        number,
        title: `Issue ${identifier}`,
        description: "",
        teamId: team.id,
        team: { id: team.id, key: team.key, name: team.key },
        state: { id: randomUUID(), name: "Todo", type: "unstarted" },
        priority: 0,
        priorityLabel: "No priority",
        labels: [],
        url: `https://linear.app/stub/issue/${identifier}`,
        ...fields,
      };
    },
    person(name: string) {
      return { id: randomUUID(), name, type: "user" };
    },
  };

  async function linearApi(request: Request): Promise<Response> {
    const { query = "", variables = {} } = (await request.json().catch(() => ({}))) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const operation =
      /\b(issueCreate|commentCreate|commentUpdate|commentDelete|issueUpdate)\b/.exec(query)?.[1] ??
      (/\bviewer\b/.test(query) ? "viewer" : /\bissue\s*\(/.test(query) ? "issue" : "unknown");
    const call = {
      platform: "linear" as const,
      what: operation,
      args: variables,
      authorization: request.headers.get("authorization"),
    };
    const data = (value: unknown) => Response.json({ data: value });
    const refused = (message: string) =>
      Response.json({ errors: [{ message, extensions: { code: "INVALID_INPUT" } }] });
    return answered(call, () => {
      if (call.authorization !== linear.token) {
        return Response.json({ errors: [{ message: "Authentication required" }] }, { status: 401 });
      }
      const input = (variables["input"] ?? {}) as Record<string, string | undefined>;
      switch (operation) {
        case "viewer":
          return data({
            viewer: linear.viewer,
            teams: { nodes: [...linear.teams].map(([key, id]) => ({ id, key, name: key })) },
          });
        case "issue": {
          const wanted = String(variables["id"] ?? "");
          const issue = [...linear.issues.values()].find(
            (each) => each.id === wanted || each.identifier === wanted,
          );
          if (!issue) return refused("Entity not found: Issue");
          return data({
            issue: {
              ...issue,
              team: { id: issue.teamId },
              creator: linear.viewer,
              state: { type: "unstarted" },
              labels: { nodes: [] },
            },
          });
        }
        case "issueCreate": {
          const id = input["id"] ?? randomUUID();
          if (linear.issues.has(id)) return refused("An issue with this ID exists already.");
          const key = [...linear.teams].find(([, team]) => team === input["teamId"])?.[0];
          if (key === undefined) return refused("Entity not found: Team");
          const identifier = `${key}-${next()}`;
          const issue = {
            id,
            identifier,
            teamId: input["teamId"] ?? "",
            title: input["title"] ?? "",
            description: input["description"] ?? "",
            url: `https://linear.app/stub/issue/${identifier}`,
          };
          linear.issues.set(id, issue);
          return data({ issueCreate: { success: true, issue: { id, url: issue.url } } });
        }
        case "commentCreate": {
          const id = input["id"] ?? randomUUID();
          if (!linear.issues.has(input["issueId"] ?? "")) return refused("Entity not found: Issue");
          linear.comments.set(id, {
            id,
            issueId: input["issueId"] ?? "",
            body: input["body"] ?? "",
          });
          return data({
            commentCreate: {
              success: true,
              comment: { id, url: `https://linear.app/stub/comment/${id}` },
            },
          });
        }
        case "commentUpdate": {
          const comment = linear.comments.get(String(variables["id"]));
          if (!comment) return refused("Entity not found: Comment");
          comment.body = input["body"] ?? "";
          return data({ commentUpdate: { success: true } });
        }
        case "commentDelete":
          linear.comments.delete(String(variables["id"]));
          return data({ commentDelete: { success: true } });
        case "issueUpdate": {
          const issue = linear.issues.get(String(variables["id"]));
          if (!issue) return refused("Entity not found: Issue");
          issue.description = input["description"] ?? issue.description;
          return data({ issueUpdate: { success: true } });
        }
        default:
          return refused(`The stub doesn't speak this: ${query.slice(0, 80)}`);
      }
    });
  }

  /** Answers a request to any of the three, by the path it is under. `null` for one that is none of theirs. */
  async function handle(request: Request, path: string): Promise<Response | null> {
    if (path.startsWith("/slack/api/")) {
      const form = new URLSearchParams(await request.text());
      return slackApi(path.slice("/slack/api/".length), request, form);
    }
    if (path.startsWith("/github/")) return githubApi(request, path.slice("/github".length));
    if (path === "/linear/graphql") return linearApi(request);
    return null;
  }

  let server: ReturnType<typeof Bun.serve> | null = null;

  return {
    calls,
    slack,
    github,
    linear,

    /** The calls Vibe made, to one platform or to all, that the stub accepted. */
    accepted(platform?: PlatformCall["platform"], what?: string): PlatformCall[] {
      return calls.filter(
        (call) =>
          call.ok &&
          (platform === undefined || call.platform === platform) &&
          (what === undefined || call.what.includes(what)),
      );
    },
    /**
     * Makes the next `times` calls fail, as a platform that is down does.
     *
     * @param matching Only calls of this kind, such as `chat.postMessage`.
     */
    fail(
      times: number,
      options: { matching?: string; status?: number; retryAfter?: number } = {},
    ): void {
      failing.push({
        left: times,
        matching: options.matching,
        status: options.status ?? 503,
        retryAfter: options.retryAfter,
      });
    },
    /** Lets every call through again. */
    recover(): void {
      failing.length = 0;
    },

    /**
     * The `fetch` for an app in this process: what it asks of Slack, GitHub's
     * REST API with the stub's own token, or Linear, the stub answers. The
     * rest goes to `otherwise`.
     */
    fetch(otherwise: (url: string, init?: RequestInit) => Promise<Response>) {
      return async (url: string, init: RequestInit = {}): Promise<Response> => {
        const { hostname, pathname } = new URL(url);
        const request = () => new Request(url, init);
        if (hostname === "slack.com") {
          return (
            (await handle(request(), `/slack${pathname}`)) ?? Response.json({}, { status: 404 })
          );
        }
        if (hostname === "api.linear.app") {
          return (
            (await handle(request(), `/linear${pathname}`)) ?? Response.json({}, { status: 404 })
          );
        }
        const authorization = new Headers(init.headers).get("authorization");
        if (hostname === "api.github.com" && authorization === `Bearer ${github.token}`) {
          return (
            (await handle(request(), `/github${pathname}`)) ?? Response.json({}, { status: 404 })
          );
        }
        return otherwise(url, init);
      };
    },

    /**
     * Serves the stub on the loopback, for a Vibe that runs elsewhere on this
     * machine, and says where each platform's API is there.
     */
    listen(): { slack: string; github: string; linear: string } {
      server ??= Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          const answer = await handle(request, new URL(request.url).pathname);
          return (
            answer ?? Response.json({ message: "The stub has nothing here." }, { status: 404 })
          );
        },
      });
      const base = `http://127.0.0.1:${server.port}`;
      return {
        slack: `${base}/slack/api`,
        github: `${base}/github`,
        linear: `${base}/linear/graphql`,
      };
    },
    async stop(): Promise<void> {
      await server?.stop(true);
      server = null;
    },
  };
}

export type PlatformStubs = ReturnType<typeof platformStubs>;
