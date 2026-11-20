import type { HeldToken, OpenSession, VibeHandle } from "@vibe/sdk";

import { ago } from "./format.ts";
import { UsageError } from "./shared.ts";

export interface CredentialSession {
  flags: { json?: boolean | undefined };
  client(): VibeHandle;
  out(human: string, data: unknown): void;
}

const TOKENS_USAGE = `Usage: vibe tokens                 List the tokens you hold: what each is, never its secret
       vibe tokens revoke <id>     Revoke one. What it minted, and sessions it opened, end with it
       vibe token create --as <PROFILE> --can <PATTERN=PERMS>... [--ttl <DURATION>]`;

const SESSIONS_USAGE = `Usage: vibe sessions               List the browsers you are signed in from
       vibe sessions end <id>      Sign one of them out, from here`;

/** `vibe tokens`: the tokens you hold, and revoking one. */
export async function tokens(session: CredentialSession, args: string[]): Promise<number> {
  const { out } = session;
  const [verb, id] = args;
  const handle = session.client();

  switch (verb) {
    case undefined:
    case "list": {
      const list = await handle.tokens();
      out(list.map((token) => tokenLine(token)).join("\n"), { tokens: list });
      return 0;
    }
    case "revoke": {
      if (!id) throw new UsageError(TOKENS_USAGE);
      const token = await handle.revokeToken(id);
      out(revokedLine(token), { token });
      return 0;
    }
    default:
      throw new UsageError(`Unknown tokens command "${verb}".\n${TOKENS_USAGE}`);
  }
}

/** `vibe sessions`: the browsers you are signed in from, and signing one out. */
export async function sessions(session: CredentialSession, args: string[]): Promise<number> {
  const { out } = session;
  const [verb, id] = args;
  const handle = session.client();

  switch (verb) {
    case undefined:
    case "list": {
      const list = await handle.sessions();
      out(
        list.length > 0 ? list.map(sessionLine).join("\n") : "You are signed in from no browser.",
        { sessions: list },
      );
      return 0;
    }
    case "end": {
      if (!id) throw new UsageError(SESSIONS_USAGE);
      await handle.endSession(id);
      out(`ended ${id}: that browser is signed out`, { ended: true, id });
      return 0;
    }
    default:
      throw new UsageError(`Unknown sessions command "${verb}".\n${SESSIONS_USAGE}`);
  }
}

/** A token on one line: its ID, what it is, and what tells it from the others. */
export function tokenLine(token: HeldToken, now: number = Date.now()): string {
  const parts = [token.id.padEnd(30), token.kind.padEnd(9)];
  if (token.delegated === null) {
    parts.push(token.label ?? "(no label)", `made ${ago(token.createdAt, now)}`);
  } else {
    const { vibe, profile, can } = token.delegated;
    parts.push(
      `writes as ${profile} in ${vibe.name ?? vibe.id}`,
      `until ${token.expiresAt ?? "revoked"}`,
      Object.entries(can)
        .map(([pattern, list]) => `${pattern}=${list.join(",") || "none"}`)
        .join(" "),
    );
  }
  if (token.current) parts.push("(this one)");
  return parts.join("  ");
}

export function revokedLine(token: HeldToken): string {
  const also =
    token.kind === "user"
      ? " Delegated tokens minted with it, and browser sessions opened with it, ended too."
      : token.kind === "service"
        ? " Delegated tokens minted with it ended too."
        : "";
  return `revoked ${token.id}.${also}`;
}

function sessionLine(session: OpenSession): string {
  const parts = [
    session.id.padEnd(30),
    `signed in ${ago(session.createdAt)}`,
    `until ${session.expiresAt.slice(0, 10)}`,
    session.userAgent ?? "(a browser that didn't say)",
  ];
  if (session.current) parts.push("(this one)");
  return parts.join("  ");
}
