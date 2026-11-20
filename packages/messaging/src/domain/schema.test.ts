import { describe, expect, test } from "bun:test";

import { DomainError } from "@vibe/kernel";

import { JsonSchemaChecker } from "../infrastructure/json-schema-checker.ts";
import { newSchema, parseSchemaId, sameDefinition, schemaId } from "./schema.ts";

const code = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
};
const base = { teamId: "team_1", createdBy: "vibe:user:u_ada", now: 1 };

describe("schema", () => {
  test("is named by a name and a version, regardless of case", () => {
    expect(parseSchemaId("Sandbox@1")).toEqual({ name: "sandbox", version: 1 });
    expect(schemaId({ name: "git-commit", version: 12 })).toBe("git-commit@12");
    for (const id of ["sandbox", "sandbox@", "@1", "sandbox@1.5", "sand box@1", "1box@1", "a@0"]) {
      expect([id, code(() => parseSchemaId(id))]).toEqual([id, "invalid_schema"]);
    }
  });

  test("describes an object, in a definition of bounded size", () => {
    const schema = newSchema({
      ...base,
      name: "sandbox",
      version: 1,
      description: "  What a sandbox did.  ",
      definition: { type: "object" },
    });
    expect(schema).toMatchObject({ name: "sandbox", description: "What a sandbox did." });

    const define = (definition: unknown) => () =>
      newSchema({ ...base, name: "sandbox", version: 1, definition });
    expect(code(define({ type: "string" }))).toBe("invalid_schema");
    expect(code(define([{ type: "object" }]))).toBe("invalid_schema");
    expect(code(define("object"))).toBe("invalid_schema");
    expect(code(define({ type: "object", description: "x".repeat(70_000) }))).toBe(
      "invalid_schema",
    );
  });

  test("two definitions are the same whatever order their keys come in", () => {
    const a = { type: "object", properties: { id: { type: "string" }, n: { type: "number" } } };
    const b = { properties: { n: { type: "number" }, id: { type: "string" } }, type: "object" };
    expect(sameDefinition(a, b)).toBe(true);
    expect(sameDefinition(a, { ...b, required: ["id"] })).toBe(false);
    // Order in a list is part of what it says.
    expect(sameDefinition({ enum: ["a", "b"] }, { enum: ["b", "a"] })).toBe(false);
  });
});

describe("the JSON Schema checker", () => {
  const checker = new JsonSchemaChecker();
  const sandbox = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" }, run: { $ref: "#/$defs/run" } },
    $defs: { run: { type: "object", properties: { exit: { type: "integer" } } } },
  };

  test("says where data goes wrong, by the innermost thing that failed", () => {
    expect(checker.mismatch(sandbox, { id: "sbx-1", run: { exit: 0 } })).toBeNull();
    expect(checker.mismatch(sandbox, {})).toContain('required property "id"');
    expect(checker.mismatch(sandbox, { id: "sbx-1", run: { exit: "zero" } })).toStartWith(
      "at run.exit, ",
    );
    expect(checker.mismatch(sandbox, [])).toContain('Expected "object"');
  });

  test("refuses a definition that could only fail later", () => {
    expect(checker.unusable(sandbox)).toBeNull();
    expect(
      checker.unusable({ type: "object", properties: { a: { $ref: "https://x.test/a" } } }),
    ).toContain("https://x.test/a");
    expect(checker.unusable({ type: "object", patternProperties: { "(": {} } })).toContain(
      "regular expression",
    );
    expect(
      checker.unusable({ type: "object", properties: { a: { $ref: "#/$defs/gone" } } }),
    ).toBeNull();
    // A reference to a part that isn't there fails the data, not the process.
    expect(
      checker.mismatch({ type: "object", properties: { a: { $ref: "#/$defs/gone" } } }, { a: 1 }),
    ).toContain("can't be applied");
  });
});
