import type { BlockInput, Schema, VibeHandle } from "@vibe/sdk";

import { readText, UsageError } from "./shared.ts";

export interface SchemaFlags {
  file?: string | undefined;
  data?: string | undefined;
  description?: string | undefined;
}

export interface SchemaSession {
  flags: SchemaFlags;
  client(): VibeHandle;
  out(human: string, data: unknown): void;
}

const USAGE = `Usage: vibe schemas                          List the team's schemas
       vibe schemas inspect <name@version>   Print one schema
       vibe schemas create <name@version> (--file <PATH> | --data <JSON>) [--description <TEXT>]`;

export async function schemas(session: SchemaSession, args: string[]): Promise<number> {
  const { flags, out } = session;
  const [verb, id] = args;
  const handle = session.client();

  switch (verb) {
    case undefined:
    case "list": {
      const list = await handle.schemas();
      out(
        list.length > 0
          ? list.map(schemaLine).join("\n")
          : "No schemas yet. `vibe schemas create` registers one.",
        { schemas: list },
      );
      return 0;
    }
    case "inspect": {
      if (!id) throw new UsageError(USAGE);
      const schema = await handle.schema(id);
      out([schemaLine(schema), "", JSON.stringify(schema.schema, null, 2)].join("\n"), { schema });
      return 0;
    }
    case "create": {
      const match = /^([^@]+)@(\d+)$/.exec(id ?? "");
      if (!match?.[1] || !match[2] || (flags.file === undefined) === (flags.data === undefined)) {
        throw new UsageError(USAGE);
      }
      const source = flags.data ?? (await readText(flags.file, ""));
      const made = await handle.createSchema({
        name: match[1],
        version: Number(match[2]),
        description: flags.description,
        schema: jsonObject(source, "The schema"),
      });
      out(
        made.created
          ? `registered ${made.schema.id}`
          : `${made.schema.id} is already registered, with this definition`,
        made,
      );
      return 0;
    }
    default:
      throw new UsageError(`Unknown schemas command "${verb}".\n${USAGE}`);
  }
}

function schemaLine(schema: Schema): string {
  return schema.description === null ? schema.id : `${schema.id.padEnd(24)}  ${schema.description}`;
}

/** The data `--schema` posts: the command's text, read as a JSON object. */
export function blockFrom(schema: string, text: string): BlockInput {
  return { schema, data: jsonObject(text, `With --schema, the text is the data, and it`) };
}

function jsonObject(source: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new UsageError(`${what} must be JSON, such as '{"id":"sbx-123"}'.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`${what} must be a JSON object, such as '{"id":"sbx-123"}'.`);
  }
  return parsed as Record<string, unknown>;
}
