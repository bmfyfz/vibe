import { type Schema as JsonSchema, Validator } from "@cfworker/json-schema";

import type { SchemaChecker } from "../application/ports.ts";

const DRAFT = "2020-12";

/**
 * Checks data against JSON Schema by walking the schema, not by compiling it:
 * compiling generates code from strings, which the Workers runtime refuses.
 */
export class JsonSchemaChecker implements SchemaChecker {
  unusable(definition: Readonly<Record<string, unknown>>): string | null {
    const found = findUnusable(definition);
    if (found !== null) return found;
    try {
      new Validator(definition as JsonSchema, DRAFT).validate({});
      return null;
    } catch (error) {
      return firstLine(error);
    }
  }

  mismatch(definition: Readonly<Record<string, unknown>>, data: unknown): string | null {
    let result: ReturnType<Validator["validate"]>;
    try {
      result = new Validator(definition as JsonSchema, DRAFT).validate(data);
    } catch (error) {
      return `the schema can't be applied. ${firstLine(error)}`;
    }
    if (result.valid) return null;
    // The last error is the innermost: the one that names what is wrong.
    const error = result.errors[result.errors.length - 1];
    if (!error) return "it doesn't match.";
    const where = error.instanceLocation.replace(/^#\/?/, "").replaceAll("/", ".");
    const what = error.error.replace(/^Instance /, "it ");
    return where === "" ? what : `at ${where}, ${what}`;
  }
}

/**
 * What a walk of the definition finds that would only fail later, when data
 * reaches it: a reference to a schema somewhere else, which is never fetched,
 * or a pattern that isn't a regular expression.
 */
function findUnusable(node: unknown, depth = 0): string | null {
  if (node === null || typeof node !== "object") return null;
  if (depth > 64) return "it nests too deeply.";
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUnusable(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const schema = node as Record<string, unknown>;
  for (const key of ["$ref", "$recursiveRef", "$dynamicRef"]) {
    const ref = schema[key];
    if (typeof ref === "string" && !ref.startsWith("#")) {
      return `it refers to ${ref}. A schema can only refer to its own parts, such as #/$defs/name.`;
    }
  }
  const patterns = [
    ...(typeof schema["pattern"] === "string" ? [schema["pattern"]] : []),
    ...(isObject(schema["patternProperties"]) ? Object.keys(schema["patternProperties"]) : []),
  ];
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "u");
    } catch {
      return `"${pattern}" is not a regular expression.`;
    }
  }
  for (const value of Object.values(schema)) {
    const found = findUnusable(value, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
