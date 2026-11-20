import { describe, expect, test } from "bun:test";

import { block, VibeError } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
const status = (error: unknown) => (error instanceof VibeError ? error.status : -1);

const SANDBOX = {
  type: "object",
  required: ["id", "action"],
  properties: { id: { type: "string" }, action: { enum: ["started", "stopped"] } },
  additionalProperties: false,
};

/** A schema name no other test, or earlier run, has used. */
const name = (prefix = "sandbox") => vibe.channel(prefix);

describe("schemas", () => {
  test("a schema is registered under a name and a version, and read back", async () => {
    const { client: ada } = await vibe.join();
    const sandbox = name();

    const made = await ada.createSchema({
      name: sandbox,
      version: 1,
      description: "What a sandbox did.",
      schema: SANDBOX,
    });
    expect(made.created).toBe(true);
    expect(made.schema).toMatchObject({
      id: `${sandbox}@1`,
      name: sandbox,
      version: 1,
      description: "What a sandbox did.",
      schema: SANDBOX,
    });

    expect(await ada.schema(`${sandbox}@1`)).toEqual(made.schema);
    const listed = (await ada.schemas()).filter((schema) => schema.name === sandbox);
    expect(listed).toEqual([made.schema]);
  });

  test("a version never changes: the same definition does nothing, another is refused", async () => {
    const { client: ada } = await vibe.join();
    const sandbox = name();
    await ada.createSchema({ name: sandbox, version: 1, schema: SANDBOX });

    // The same definition, its keys in another order.
    const again = await ada.createSchema({
      name: sandbox,
      version: 1,
      schema: {
        additionalProperties: false,
        properties: { action: { enum: ["started", "stopped"] }, id: { type: "string" } },
        required: ["id", "action"],
        type: "object",
      },
    });
    expect(again.created).toBe(false);

    const changed = await ada
      .createSchema({ name: sandbox, version: 1, schema: { type: "object" } })
      .catch((e) => e);
    expect([code(changed), status(changed)]).toEqual(["schema_immutable", 409]);
    expect((await ada.schema(`${sandbox}@1`)).schema).toEqual(SANDBOX);

    // The next version is how a schema changes.
    const next = await ada.createSchema({ name: sandbox, version: 2, schema: { type: "object" } });
    expect(next.schema.id).toBe(`${sandbox}@2`);
    const versions = (await ada.schemas()).filter((schema) => schema.name === sandbox);
    expect(versions.map((schema) => schema.version)).toEqual([1, 2]);
  });

  test("two registrations of one version at once agree, or one is refused", async () => {
    const { client: ada } = await vibe.join();
    const sandbox = name();
    const same = await Promise.all(
      [1, 2, 3].map(() => ada.createSchema({ name: sandbox, version: 1, schema: SANDBOX })),
    );
    expect(same.filter((result) => result.created)).toHaveLength(1);

    const other = name();
    const raced = await Promise.all(
      [{ type: "object" }, { type: "object", required: ["a"] }].map((schema) =>
        ada.createSchema({ name: other, version: 1, schema }).then(
          () => "created",
          (error) => code(error),
        ),
      ),
    );
    expect(raced.sort()).toEqual(["created", "schema_immutable"]);
  });

  test("registering takes manage at *, and reading takes being on the team", async () => {
    const owner = await vibe.owner();
    const { client: viewer } = await vibe.join("viewer");
    const { handle, client: bob } = await vibe.join();
    const sandbox = name();

    const refused = await viewer
      .createSchema({ name: sandbox, version: 1, schema: SANDBOX })
      .catch((e) => e);
    expect([code(refused), status(refused)]).toEqual(["forbidden", 403]);

    // A member holds manage at * until a grant takes it away.
    await bob.createSchema({ name: sandbox, version: 1, schema: SANDBOX });
    expect((await viewer.schema(`${sandbox}@1`)).schema).toEqual(SANDBOX);

    const scratch = vibe.channel("only");
    const narrowed = await owner.createGrant({
      principals: [{ kind: "user", handle }],
      can: { "*": ["read", "post", "label"], [scratch]: "all" },
    });
    try {
      const error = await bob
        .createSchema({ name: sandbox, version: 2, schema: SANDBOX })
        .catch((e) => e);
      expect([code(error), status(error)]).toEqual(["forbidden", 403]);
    } finally {
      await owner.revokeGrant(narrowed.id);
    }
  });

  test("a definition that isn't a usable schema for an object is refused", async () => {
    const { client: ada } = await vibe.join();
    const attempts: [string, number, Record<string, unknown>][] = [
      ["Bad Name!", 1, SANDBOX],
      [name(), 0, SANDBOX],
      [name(), 1, { type: "string" }],
      [name(), 1, { properties: { id: { type: "string" } } }],
      [name(), 1, { type: "object", properties: { id: { $ref: "https://example.com/id" } } }],
      [name(), 1, { type: "object", properties: { id: { pattern: "(" } } }],
    ];
    for (const [schemaName, version, schema] of attempts) {
      const error = await ada.createSchema({ name: schemaName, version, schema }).catch((e) => e);
      expect([schemaName, code(error), status(error)]).toEqual([schemaName, "invalid_schema", 400]);
    }

    const missing = await ada.schema(`${name()}@1`).catch((e) => e);
    expect([code(missing), status(missing)]).toEqual(["schema_not_found", 404]);
  });
});

describe("structured data", () => {
  test("a message carries data that matches a schema, and every read returns it parsed", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const sandbox = name();
    await ada.createSchema({ name: sandbox, version: 1, schema: SANDBOX });
    const channel = vibe.channel();
    const data = { id: "sbx-123", action: "started" };

    // Data alone is a message: it needs no text.
    const root = await ada.post(channel, "", { blocks: [block(`${sandbox}@1`, data)] });
    expect(root.text).toBe("");
    expect(root.blocks).toEqual([{ schema: sandbox, version: 1, data }]);

    const reply = await bob.reply(root.id, "it stopped", {
      blocks: [block(`${sandbox}@1`, { id: "sbx-123", action: "stopped" })],
    });
    expect(reply.blocks[0]?.data).toEqual({ id: "sbx-123", action: "stopped" });

    const thread = await bob.thread(root.id);
    expect(thread.message.blocks).toEqual(root.blocks);
    expect(thread.replies[0]?.blocks).toEqual(reply.blocks);
    const { threads } = await bob.threads({ channel });
    expect(threads[0]?.message.blocks).toEqual(root.blocks);
    expect(threads[0]?.last?.blocks).toEqual(reply.blocks);

    const { events } = await bob.poll({ channel, after: root.id });
    expect(events.map((event) => event.message?.blocks?.[0]?.data)).toEqual([
      { id: "sbx-123", action: "stopped" },
    ]);
    // A message without data has an empty list, never a missing field.
    expect((await ada.post(channel, "plain")).blocks).toEqual([]);
  });

  test("data that doesn't match is refused when the message is written, and nothing is posted", async () => {
    const { client: ada } = await vibe.join();
    const sandbox = name();
    await ada.createSchema({ name: sandbox, version: 1, schema: SANDBOX });
    const channel = vibe.channel();

    const wrong: Record<string, unknown>[] = [
      { id: "sbx-1", action: "exploded" },
      { id: 7, action: "started" },
      { action: "started" },
      { id: "sbx-1", action: "started", extra: true },
    ];
    for (const data of wrong) {
      const error = await ada
        .post(channel, "look", { blocks: [block(`${sandbox}@1`, data)] })
        .catch((e) => e);
      expect([data, code(error), status(error)]).toEqual([data, "invalid_block", 400]);
    }
    // The refusal says where the data goes wrong.
    const error = await ada
      .post(channel, "", { blocks: [block(`${sandbox}@1`, { id: "sbx-1", action: "exploded" })] })
      .catch((e) => e);
    expect((error as VibeError).message).toContain("action");

    const unknown = await ada
      .post(channel, "", { blocks: [block(`${sandbox}@7`, { id: "a", action: "started" })] })
      .catch((e) => e);
    expect([code(unknown), status(unknown)]).toEqual(["schema_not_found", 400]);
    const unnamed = await ada.post(channel, "", { blocks: [block("sandbox", {})] }).catch((e) => e);
    expect(code(unnamed)).toBe("invalid_schema");

    expect((await ada.threads({ channel })).threads).toEqual([]);
    // Without text, files or data there is no message.
    expect(code(await ada.post(channel, "", { blocks: [] }).catch((e) => e))).toBe(
      "invalid_message",
    );
  });

  test("an edit replaces the data, checks it again, and leaves what it doesn't name", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const sandbox = name();
    await ada.createSchema({ name: sandbox, version: 1, schema: SANDBOX });
    const started = block(`${sandbox}@1`, { id: "sbx-9", action: "started" });
    const stopped = block(`${sandbox}@1`, { id: "sbx-9", action: "stopped" });
    const root = await ada.post(vibe.channel(), "sandbox sbx-9", { blocks: [started] });

    // New data, same text.
    const edited = await ada.edit(root.id, { blocks: [stopped] });
    expect(edited).toMatchObject({ text: "sandbox sbx-9", revision: 2 });
    const changed = [{ schema: sandbox, version: 1, data: stopped.data }];
    expect(edited?.blocks).toEqual(changed);

    // New text, same data.
    const reworded = await ada.edit(root.id, "sandbox sbx-9 is done");
    expect(reworded).toMatchObject({ text: "sandbox sbx-9 is done", revision: 3 });
    expect(reworded?.blocks).toEqual(changed);

    // The same data again changes nothing, in whatever order its keys come.
    const same = await ada.edit(root.id, {
      blocks: [block(`${sandbox}@1`, { action: "stopped", id: "sbx-9" })],
    });
    expect(same?.revision).toBe(3);

    const bad = await ada
      .edit(root.id, { blocks: [block(`${sandbox}@1`, { id: "sbx-9" })] })
      .catch((e) => e);
    expect(code(bad)).toBe("invalid_block");
    expect(code(await bob.edit(root.id, { blocks: [stopped] }).catch((e) => e))).toBe("forbidden");
    expect((await ada.thread(root.id)).message.blocks).toEqual(changed);

    // An empty list takes the data away, while there is text to be left with.
    const bare = await ada.edit(root.id, { blocks: [] });
    expect(bare).toMatchObject({ text: "sandbox sbx-9 is done", blocks: [], revision: 4 });
    const dataOnly = await ada.post(vibe.channel(), "", { blocks: [started] });
    expect(code(await ada.edit(dataOnly.id, { blocks: [] }).catch((e) => e))).toBe(
      "invalid_message",
    );
  });

  test("a deleted message loses its data, and a message holds only so many blocks", async () => {
    const { client: ada } = await vibe.join();
    const sandbox = name();
    await ada.createSchema({ name: sandbox, version: 1, schema: { type: "object" } });
    const one = block(`${sandbox}@1`, { n: 1 });
    const channel = vibe.channel();

    const root = await ada.post(channel, "", { blocks: [one, one] });
    expect(root.blocks).toHaveLength(2);
    expect((await ada.delete(root.id))?.blocks).toEqual([]);

    const many = await ada
      .post(channel, "", { blocks: Array.from({ length: 9 }, () => one) })
      .catch((e) => e);
    expect(status(many)).toBe(400);
    const heavy = await ada
      .post(channel, "", { blocks: [block(`${sandbox}@1`, { blob: "x".repeat(70_000) })] })
      .catch((e) => e);
    expect([code(heavy), status(heavy)]).toEqual(["invalid_message", 400]);
  });
});
