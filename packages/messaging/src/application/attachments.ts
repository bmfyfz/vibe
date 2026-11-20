import type { Attachment } from "@vibe/contracts";
import type { Authorizer, Caller } from "@vibe/identity";
import { type BlobStore, type Clock, invalid, lengthRequired, newId } from "@vibe/kernel";

import { attachmentNotFound, attachmentTooLarge } from "../domain/errors.ts";
import { MAX_ATTACHMENT_BYTES } from "../domain/message.ts";
import type { AttachmentRepository, VibeRecord } from "./ports.ts";

export interface UploadCommand {
  caller: Caller;
  vibe: VibeRecord;
  name: string;
  contentType: string | null;
  /** The size the client declared. Uploads are streamed, so it must be known up front. */
  size: number | null;
  body: ReadableStream<Uint8Array> | null;
}

export interface OpenedAttachment extends Attachment {
  body: ReadableStream<Uint8Array>;
}

export class Attachments {
  constructor(
    private readonly repository: AttachmentRepository,
    private readonly blobs: BlobStore,
    private readonly authorizer: Authorizer,
    private readonly clock: Clock,
  ) {}

  /** Stores a file. It belongs to no message yet: only its uploader can read it, or post it. */
  async upload(command: UploadCommand): Promise<Attachment> {
    const { repository, blobs, authorizer, clock } = this;
    const { caller, vibe } = command;
    await authorizer.require(caller, "post", { vibeId: vibe.id, channel: null });

    const name = cleanName(command.name);
    const type = command.contentType?.slice(0, 255) || "application/octet-stream";
    if (command.size === null || !Number.isInteger(command.size) || command.size < 0) {
      throw lengthRequired(
        "length_required",
        "An upload needs a Content-Length.",
        "Send the file's size in bytes in the Content-Length header.",
      );
    }
    if (command.size > MAX_ATTACHMENT_BYTES) throw attachmentTooLarge(MAX_ATTACHMENT_BYTES);
    if (command.size === 0 || !command.body) {
      throw invalid("invalid_attachment", "An attachment can't be empty.");
    }

    const now = clock.now();
    const id = newId("att", now);
    const blobKey = `${vibe.teamId}/${vibe.id}/${id}`;
    const stored = await blobs.put(blobKey, command.body, { contentType: type });
    try {
      if (stored.size > MAX_ATTACHMENT_BYTES) throw attachmentTooLarge(MAX_ATTACHMENT_BYTES);
      await repository.add({
        id,
        vibeId: vibe.id,
        uploader: caller.principal,
        uploadedBy: caller.actorId,
        blobKey,
        name,
        type,
        size: stored.size,
        createdAt: now,
      });
    } catch (error) {
      // Don't leave bytes behind that no record points to.
      await blobs.delete(blobKey).catch(() => {});
      throw error;
    }
    return { id, name, type, size: stored.size };
  }

  /**
   * Checks that a post may carry these files: its author uploaded each one, and
   * none has joined a message yet. A file can't move through someone else. For
   * a caller under a limit, "its author" is the actor it writes as: it can't
   * post, and so come to read, a file its principal uploaded.
   */
  async assertPostable(caller: Caller, vibe: VibeRecord, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.repository.findMany(vibe.id, ids);
    for (const id of ids) {
      const file = found.find((candidate) => candidate.id === id);
      const usable =
        file !== undefined &&
        file.uploader === caller.principal &&
        file.messageId === null &&
        (caller.narrowed === null || file.uploadedBy === caller.actorId);
      if (!usable) throw attachmentNotFound(id);
    }
  }

  /**
   * Opens a file for reading. Anyone who can read its message can read it.
   * Before it joins a message only its uploader can.
   */
  async open(query: { caller: Caller; vibe: VibeRecord; id: string }): Promise<OpenedAttachment> {
    const { repository, blobs, authorizer } = this;
    const { caller, vibe, id } = query;

    const file = await repository.find(vibe.id, id);
    if (!file) throw attachmentNotFound(id);
    // A caller under a limit doesn't read as its principal: an agent handed
    // part of someone's access gets none of the files they uploaded elsewhere.
    if (file.uploader !== caller.principal || caller.narrowed !== null) {
      // Unposted, it is its uploader's alone. Posted, it goes with its message:
      // readable where the message is, and hidden once the message is deleted
      // from all but those who can read every channel.
      if (file.channel === null) throw attachmentNotFound(id);
      const scope = await authorizer.scope(caller, vibe.id);
      if (!scope.allows(file.channel) || (file.hidden && !scope.all)) throw attachmentNotFound(id);
    }

    const blob = await blobs.get(file.blobKey);
    if (!blob) throw attachmentNotFound(id);
    return { id: file.id, name: file.name, type: file.type, size: file.size, body: blob.body };
  }
}

/** Keeps the last path segment and drops control characters, so a name is safe to show and to save as. */
function cleanName(input: string): string {
  const base = input.split(/[\\/]/).pop() ?? "";
  const name = Array.from(base)
    .filter((char) => char >= " " && char !== "\u007f")
    .join("")
    .trim()
    .slice(0, 255);
  if (name === "" || name === "." || name === "..") {
    throw invalid(
      "invalid_attachment",
      "An attachment needs a file name.",
      "Pass it as ?name=<file name>.",
    );
  }
  return name;
}
