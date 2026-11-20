import type { ActorDirectory, Authorizer, Caller } from "@vibe/identity";
import type { BeginUnitOfWork, Clock } from "@vibe/kernel";

import { assertBlocks, type Block, type BlockInput } from "../domain/block.ts";
import {
  invalidBlock,
  invalidSchema,
  noSuchSchema,
  schemaImmutable,
  schemaNotFound,
} from "../domain/errors.ts";
import {
  newSchema,
  parseSchemaId,
  sameDefinition,
  type Schema,
  schemaId,
} from "../domain/schema.ts";
import type { SchemaChecker, SchemaRepository, VibeRecord } from "./ports.ts";

export interface RegisterSchemaCommand {
  caller: Caller;
  /** The vibe the caller is using. The schema is for its whole team. */
  vibe: VibeRecord;
  name: string;
  version: number;
  description?: string | undefined;
  /** A JSON Schema for an object. */
  definition: unknown;
}

/**
 * The team's registry of schemas, and the check that a message's data matches
 * the schema it names.
 */
export class Schemas {
  constructor(
    private readonly repository: SchemaRepository,
    private readonly checker: SchemaChecker,
    private readonly authorizer: Authorizer,
    private readonly actors: ActorDirectory,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Registers a version of a schema. A version never changes: the same
   * definition again does nothing, and a different one is refused.
   *
   * @throws `forbidden` without `manage` at `*`, `invalid_schema` for a
   *   definition that can't be used, and `schema_immutable`.
   */
  async register(command: RegisterSchemaCommand): Promise<{ schema: Schema; created: boolean }> {
    const { repository, checker, actors, begin, clock } = this;
    const { caller, vibe } = command;
    await this.authorizer.requireAtAll(caller, "manage", vibe.id, "register a schema");

    const now = clock.now();
    const schema = newSchema({
      teamId: vibe.teamId,
      name: command.name,
      version: command.version,
      description: command.description,
      definition: command.definition,
      createdBy: caller.actorId,
      now,
    });
    const problem = checker.unusable(schema.definition);
    if (problem !== null) throw invalidSchema(`This definition can't be used: ${problem}`);

    // Twice at most: a commit that finds the version taken reads who took it.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const existing = await repository.find(vibe.teamId, schema);
      if (existing) {
        if (sameDefinition(existing.definition, schema.definition)) {
          return { schema: existing, created: false };
        }
        throw schemaImmutable(schemaId(schema));
      }
      const uow = begin();
      repository.add(uow, schema);
      actors.introduce(uow, caller, now);
      try {
        await uow.commit();
        return { schema, created: true };
      } catch (error) {
        if (!repository.isTaken(error)) throw error;
      }
    }
    throw schemaImmutable(schemaId(schema));
  }

  /** The team's schemas, by name and then version. */
  list(teamId: string): Promise<Schema[]> {
    return this.repository.list(teamId);
  }

  /** One schema, by its ID, such as `sandbox@1`. */
  async get(teamId: string, id: string): Promise<Schema> {
    const ref = parseSchemaId(id);
    const schema = await this.repository.find(teamId, ref);
    if (!schema) throw noSuchSchema(schemaId(ref));
    return schema;
  }

  /**
   * Checks the data a writer gave against the schemas it names, and returns
   * the blocks to store.
   *
   * @throws `schema_not_found` for a schema the team doesn't have, and
   *   `invalid_block` for data that doesn't match.
   */
  async settle(teamId: string, inputs: readonly BlockInput[]): Promise<Block[]> {
    const known = new Map<string, Schema>();
    const blocks: Block[] = [];
    for (const input of inputs) {
      const ref = parseSchemaId(input.schema);
      const id = schemaId(ref);
      const schema = known.get(id) ?? (await this.repository.find(teamId, ref));
      if (!schema) throw schemaNotFound(id);
      known.set(id, schema);

      const mismatch = this.checker.mismatch(schema.definition, input.data);
      if (mismatch !== null) throw invalidBlock(id, mismatch);
      blocks.push({ schema: schema.name, version: schema.version, data: input.data });
    }
    assertBlocks(blocks);
    return blocks;
  }
}
