import { canonical } from "./block.ts";
import { invalidSchema } from "./errors.ts";

/** Which schema: a name and a version, written `sandbox@1`. */
export interface SchemaRef {
  readonly name: string;
  readonly version: number;
}

/**
 * What a piece of structured data holds: a JSON Schema for an object, under a
 * name and a version. A version never changes once registered. To change a
 * schema, register the next version.
 */
export interface Schema extends SchemaRef {
  readonly teamId: string;
  readonly description: string | null;
  readonly definition: Readonly<Record<string, unknown>>;
  /** The actor that registered it. */
  readonly createdBy: string;
  readonly createdAt: number;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const ID = /^([^@]+)@(\d{1,9})$/;
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 500;
const MAX_VERSION = 1_000_000;

export function schemaId(ref: SchemaRef): string {
  return `${ref.name}@${ref.version}`;
}

/** Reads `sandbox@1`. Names match regardless of case. */
export function parseSchemaId(id: string): SchemaRef {
  const match = ID.exec(id.trim());
  if (!match?.[1] || !match[2]) {
    throw invalidSchema(
      `"${id}" doesn't name a schema.`,
      "Name a schema and its version, such as sandbox@1.",
    );
  }
  return parseSchemaRef(match[1], Number(match[2]));
}

export function parseSchemaRef(name: string, version: number): SchemaRef {
  const lower = name.toLowerCase();
  if (!NAME.test(lower)) {
    throw invalidSchema(
      `"${name}" is not a schema name.`,
      "Start with a letter and use up to 64 lowercase letters, numbers and hyphens.",
    );
  }
  if (!Number.isInteger(version) || version < 1 || version > MAX_VERSION) {
    throw invalidSchema("A schema's version is a whole number, from 1 up.");
  }
  return { name: lower, version };
}

/**
 * A schema ready to register.
 *
 * @throws `invalid_schema` unless the definition is a JSON Schema for an object.
 */
export function newSchema(input: {
  teamId: string;
  name: string;
  version: number;
  description?: string | null | undefined;
  definition: unknown;
  createdBy: string;
  now: number;
}): Schema {
  const ref = parseSchemaRef(input.name, input.version);
  const description = input.description?.trim() || null;
  if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
    throw invalidSchema(`A description holds up to ${MAX_DESCRIPTION_LENGTH} characters.`);
  }
  const { definition } = input;
  if (definition === null || typeof definition !== "object" || Array.isArray(definition)) {
    throw invalidSchema("A schema's definition is a JSON Schema, written as a JSON object.");
  }
  if ((definition as { type?: unknown }).type !== "object") {
    throw invalidSchema(
      "A schema describes an object.",
      'Give the definition `"type": "object"` at its top level.',
    );
  }
  if (new TextEncoder().encode(JSON.stringify(definition)).byteLength > MAX_SCHEMA_BYTES) {
    throw invalidSchema(`A definition holds up to ${MAX_SCHEMA_BYTES / 1024} kB.`);
  }
  return {
    ...ref,
    teamId: input.teamId,
    description,
    definition: definition as Record<string, unknown>,
    createdBy: input.createdBy,
    createdAt: input.now,
  };
}

/** Whether two definitions say the same thing, however their keys are ordered. */
export function sameDefinition(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
