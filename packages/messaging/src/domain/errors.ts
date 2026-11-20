import { conflict, forbidden, invalid, notFound, tooLarge } from "@vibe/kernel";

export const messageNotFound = (id: string) =>
  notFound("message_not_found", `No message has the ID ${id}, or you can't read it.`);

export const messageDeleted = (id: string) =>
  invalid(
    "message_deleted",
    `The message ${id} was deleted.`,
    "A deleted message can't be edited, labeled or reacted to.",
  );

export const notAuthor = () =>
  forbidden(
    "forbidden",
    "Only a message's author can edit or delete it.",
    "As yourself you can change what you and your profiles wrote. As a profile, only what it wrote.",
  );

export const revisionConflict = () =>
  conflict(
    "revision_conflict",
    "The message was edited or deleted since the revision you read, so nothing changed.",
    "Read the message again, then decide from it as it is now.",
  );

export const newerMessage = () =>
  conflict(
    "newer_message",
    "A newer message has landed in this thread.",
    "Read the thread again, then reply to its newest message.",
  );

export const duplicateId = () =>
  conflict(
    "duplicate_id",
    "This idempotency key was already used for a post in another channel or thread.",
    "Use a new key for a new post.",
  );

export const writeConflict = () =>
  conflict(
    "write_conflict",
    "This thread is too busy to accept the write right now.",
    "Send the same request again.",
  );

export const invalidMessage = (message: string, hint?: string) =>
  invalid("invalid_message", message, hint);

export const invalidLabel = (message: string, hint?: string) =>
  invalid("invalid_label", message, hint);

export const reservedLabel = (key: string) =>
  invalid(
    "reserved_label",
    `The label ${key} belongs to the vibe.`,
    "Labels under vibe. record state the vibe keeps. Change it with the command that owns it.",
  );

export const labelConflict = (key: string) =>
  conflict(
    "label_conflict",
    `The label ${key} isn't what this change expects, so nothing changed.`,
    "Read the message again, and decide from its labels as they are now.",
  );

export const attachmentNotFound = (id: string) =>
  notFound(
    "attachment_not_found",
    `No attachment has the ID ${id}, or you can't use it.`,
    "A post carries only files its author uploaded, and each file joins one message.",
  );

export const attachmentTooLarge = (limit: number) =>
  tooLarge(
    "attachment_too_large",
    `An attachment holds up to ${Math.floor(limit / 1024 / 1024)} MB.`,
  );

export const vibeNotFound = (name: string) =>
  notFound(
    "vibe_not_found",
    `This team has no vibe named ${name}.`,
    "Every team has a vibe named general.",
  );

export const invalidSchema = (message: string, hint?: string) =>
  invalid("invalid_schema", message, hint);

/** A write named a schema the team doesn't have. */
export const schemaNotFound = (id: string) =>
  invalid(
    "schema_not_found",
    `This team has no schema ${id}.`,
    "`vibe schemas` lists the schemas there are. `vibe schemas create` registers one.",
  );

/** A read asked for a schema the team doesn't have. */
export const noSuchSchema = (id: string) =>
  notFound("schema_not_found", `This team has no schema ${id}.`, "`vibe schemas` lists them.");

export const invalidBlock = (id: string, problem: string) =>
  invalid(
    "invalid_block",
    `The data doesn't match ${id}: ${problem}`,
    `\`vibe schemas inspect ${id}\` prints what it must hold.`,
  );

export const schemaImmutable = (id: string) =>
  conflict(
    "schema_immutable",
    `${id} is already registered, with a different definition.`,
    "A version never changes. Register the next version instead.",
  );
