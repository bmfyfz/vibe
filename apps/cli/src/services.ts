import type { Service, VibeHandle } from "@vibe/sdk";

import { revokedLine, tokenLine } from "./credentials.ts";
import { UsageError } from "./shared.ts";

export interface ServiceSession {
  flags: { description?: string | undefined; json?: boolean | undefined };
  client(): VibeHandle;
  out(human: string, data: unknown): void;
}

const USAGE = `Usage: vibe services                              List the team's services
       vibe services create <name> [--description <TEXT>]
                                                  Add a service and print its token
       vibe services token <name>                 Mint another token for a service
       vibe services tokens <name>                List a service's tokens, never their secrets
       vibe services revoke <name> <token-id>     Revoke one of a service's tokens
       vibe services delete <name>                Remove a service and revoke its tokens`;

/** `vibe services`: the team's machine principals, for CI jobs and workers. */
export async function services(session: ServiceSession, args: string[]): Promise<number> {
  const { flags, out } = session;
  const [verb, name, id] = args;
  const handle = session.client();

  switch (verb) {
    case undefined:
    case "list": {
      const list = await handle.services();
      out(
        list.length > 0
          ? list.map(serviceLine).join("\n")
          : "No services yet. `vibe services create <name>` adds one.",
        { services: list },
      );
      return 0;
    }
    case "create": {
      if (!name) throw new UsageError(USAGE);
      const made = await handle.createService({ name, description: flags.description });
      // Just the token on stdout, so a script can keep it: token=$(vibe services create ci)
      out(made.token, made);
      if (!flags.json) {
        console.error(
          `Added the service ${made.service.name} (${made.service.id}). Its token is shown this once.`,
        );
      }
      return 0;
    }
    case "token": {
      if (!name) throw new UsageError(USAGE);
      const token = await handle.createServiceToken(name);
      out(token, { token });
      if (!flags.json) console.error(`A new token for ${name}, shown this once.`);
      return 0;
    }
    case "tokens": {
      if (!name) throw new UsageError(USAGE);
      const list = await handle.serviceTokens(name);
      out(
        list.length > 0
          ? list.map((token) => tokenLine(token)).join("\n")
          : `${name} has no token that works. \`vibe services token ${name}\` mints one.`,
        { tokens: list },
      );
      return 0;
    }
    case "revoke": {
      if (!name || !id) throw new UsageError(USAGE);
      const token = await handle.revokeServiceToken(name, id);
      out(revokedLine(token), { token });
      return 0;
    }
    case "delete":
    case "rm": {
      if (!name) throw new UsageError(USAGE);
      const service = await handle.deleteService(name);
      out(`removed ${service.name}, and revoked its tokens`, { service });
      return 0;
    }
    default:
      throw new UsageError(`Unknown services command "${verb}".\n${USAGE}`);
  }
}

function serviceLine(service: Service): string {
  const line = `${service.name.padEnd(24)}  ${service.id}`;
  return service.description === null ? line : `${line}  ${service.description}`;
}
