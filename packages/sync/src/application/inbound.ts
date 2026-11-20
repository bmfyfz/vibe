import type { Authorizer, Caller } from "@vibe/identity";
import { type Clock, newId } from "@vibe/kernel";
import {
  type ChangeMessage,
  MAX_TEXT_LENGTH,
  type MessagingQueries,
  type PostMessage,
  type VibeRecord,
} from "@vibe/messaging";

import { describeFailure, isFinalRefusal } from "../domain/delivery.ts";
import { sourceNotFound } from "../domain/errors.ts";
import { platformLabelChange } from "../domain/labels.ts";
import {
  platformActorId,
  platformHandles,
  platformName,
  platformProfile,
  type PlatformUser,
} from "../domain/platform-user.ts";
import { labelOf, mappingFor } from "../domain/source.ts";
import { formatTarget, webLink } from "../domain/target.ts";
import type { Contexts, Opened } from "./contexts.ts";
import {
  type Inbound,
  type InboundMessage,
  type RawWebhook,
  USER_MENTION,
  withoutMarks,
} from "./platform.ts";
import type {
  CallerDirectory,
  EventSource,
  Inbox,
  PlatformActors,
  SourceRepository,
  SyncedThread,
  SyncRecords,
  VibeDirectory,
} from "./ports.ts";
import type { Receipts } from "./receipts.ts";

/** What a webhook is answered with. */
export interface WebhookAnswer {
  status: number;
  body: string;
  contentType: string;
}

/** What a platform is told when its event was taken, whatever became of it. */
const TAKEN: WebhookAnswer = { status: 200, body: '{"ok":true}', contentType: "application/json" };

// A platform's message can be several times as long as a vibe's.
const CUT = "\n\n… (cut short)";
// A text names this many platform users at most that are looked up to be mentioned.
const MAX_LOOKUPS = 10;

/** How sync, and what it needs of the vibe, are told apart in a note. */
type Note = string | null;

/**
 * What a platform sends: verified, recorded, and then applied to the vibe as
 * the platform user who did it, through the same commands a request goes
 * through. So what comes in is checked against the grants of the service
 * that syncs it, and is ordered and guarded like any other write.
 */
export class Receive {
  constructor(
    private readonly sources: SourceRepository,
    private readonly records: SyncRecords,
    private readonly inbox: Inbox,
    private readonly contexts: Contexts,
    private readonly actors: PlatformActors,
    private readonly vibes: VibeDirectory,
    private readonly callers: CallerDirectory,
    private readonly authorizer: Authorizer,
    private readonly poster: PostMessage,
    private readonly changer: ChangeMessage,
    private readonly messages: MessagingQueries,
    private readonly events: EventSource,
    private readonly receipts: Receipts,
    private readonly clock: Clock,
  ) {}

  /**
   * Takes one webhook for a sync entry.
   *
   * Nothing is believed before the signature is checked: not the body, and
   * not which event it claims to be. A delivery that was dealt with before is
   * acknowledged and left alone. One that breaks on the way is recorded as
   * failed and thrown on, so the platform is told to send it again.
   *
   * @throws `source_not_found` for no such entry, and `webhook_refused` for a
   *   request the platform didn't sign.
   */
  async webhook(sourceId: string, request: RawWebhook): Promise<WebhookAnswer> {
    const source = await this.sources.byId(sourceId);
    if (source?.state !== "active" || !this.contexts.available) {
      throw sourceNotFound(sourceId);
    }
    const opened = await this.contexts.open(source);
    const now = this.clock.now();
    await opened.platform.verify(request, opened.context.credentials, now);

    // Read without the two characters that mark a mention an adapter found:
    // nothing a platform sends can carry one of its own.
    const received = opened.platform.read({ ...request, body: withoutMarks(request.body) }, source);
    const fresh = await this.inbox.receive({
      sourceId: source.id,
      deliveryId: received.deliveryId,
      event: received.event,
      body: redacted(request.body),
      receivedAt: now,
    });
    if (received.answer) {
      await this.inbox.settle(source.id, received.deliveryId, "ignored", "A question, answered.");
      return { status: 200, ...received.answer };
    }
    if (!fresh) return TAKEN;

    try {
      // A platform's link is kept only when it is a web address.
      const changes = received.changes.map((change) =>
        "url" in change ? { ...change, url: webLink(change.url) } : change,
      );
      const notes = await this.apply(opened, changes);
      const applied = notes.some((note) => note === null);
      const said = notes.filter((note) => note !== null).join(" ") || received.note || null;
      await this.inbox.settle(
        source.id,
        received.deliveryId,
        applied ? "done" : "ignored",
        applied ? null : said,
      );
      return TAKEN;
    } catch (error) {
      await this.inbox
        .settle(source.id, received.deliveryId, "failed", describeFailure(error))
        .catch(() => {});
      throw error;
    }
  }

  /** Applies what an event changes, in order. Each change answers with why it did nothing, or `null`. */
  private async apply(opened: Opened, changes: readonly Inbound[]): Promise<Note[]> {
    if (changes.length === 0) return [];
    const { source } = opened.context;
    const vibe = await this.vibes.find(source.vibeId);
    // The entry writes as its service, with the access the service has now.
    const service = await this.callers.callerOf(source.principal, null);
    if (!vibe || !service || service.teamId !== vibe.teamId) {
      await this.sources.stop(source.id, "author_not_found");
      return ["The service this entry acts as is gone."];
    }

    const notes: Note[] = [];
    for (const change of changes) {
      try {
        notes.push(await this.change(opened, vibe, service, change));
      } catch (error) {
        // A refusal is the vibe's answer, and sending the event again would
        // get the same one. Anything else is a failure, and is thrown on. So
        // is a thread too busy to write to: that passes, and the platform's
        // next try at the event must find it still to be done.
        if (!isFinalRefusal(error)) throw error;
        notes.push(`${error.code}: ${error.message}`);
      }
    }
    return notes;
  }

  private change(
    opened: Opened,
    vibe: VibeRecord,
    service: Caller,
    change: Inbound,
  ): Promise<Note> {
    switch (change.kind) {
      case "message":
        return this.message(opened, vibe, service, change);
      case "edit":
        return this.edit(opened, vibe, service, change.message, change.text);
      case "delete":
        return this.remove(opened, vibe, service, change.message);
      case "reaction":
        return this.react(opened, vibe, service, change);
      case "state":
        return this.state(opened, vibe, service, change);
    }
  }

  private async message(
    opened: Opened,
    vibe: VibeRecord,
    service: Caller,
    change: InboundMessage,
  ): Promise<Note> {
    const { source } = opened.context;
    if (await this.records.copyByPlatform(source.id, change.message)) return "It came in before.";
    let joined = await this.records.threadByPlatform(source.id, change.thread);

    if (change.root) {
      if (joined) return "Its thread is already here.";
      const mapping = mappingFor(source.config, change.channel, change.only);
      if (!mapping) return `${change.channel} isn't mapped to a channel.`;
      return this.bring(opened, vibe, service, change, mapping.channel, null);
    }

    if (!joined) {
      // A reply in a thread that began before the channel was mapped: the
      // thread comes in from its first message.
      const mapped = mappingFor(source.config, change.channel, change.only) !== null;
      const root = mapped
        ? await opened.platform.root?.(opened.context, change.channel, change.thread)
        : null;
      if (!root) return "Its thread isn't synced.";
      await this.message(opened, vibe, service, root);
      joined = await this.records.threadByPlatform(source.id, change.thread);
      if (!joined) return "Its thread could not be brought in.";
    }
    const root = await this.messages.getMessage(vibe.id, joined.threadId);
    if (!root) return "Its thread is gone.";
    return this.bring(opened, vibe, service, change, root.channel, joined);
  }

  /** Posts a platform's message as the platform user who wrote it, with the record of which message it is. */
  private async bring(
    opened: Opened,
    vibe: VibeRecord,
    service: Caller,
    change: InboundMessage,
    channel: string,
    joined: SyncedThread | null,
  ): Promise<Note> {
    const { source } = opened.context;
    const refusal = await this.refused(service, vibe, channel);
    if (refusal) return refusal;

    const author = await this.actorFor(opened, service, change.author);
    const text = await this.settle(opened, service, change.text);
    const now = this.clock.now();
    // Read before the post, whose own event lands after it: the post is not
    // sent back to where it came from, and what follows it is sent on.
    const since = await this.events.place(vibe.id);
    const joinId = joined?.id ?? newId("sth", now);
    try {
      const posted = await this.poster.execute({
        caller: author,
        vibe,
        ...(joined ? { re: joined.threadId } : { channel }),
        text,
        mentions: opened.platform.handlesMention ? undefined : "exact",
        labels: joined ? undefined : change.labels,
        source: source.key,
        alongside: (uow, landed) => {
          if (!joined) {
            this.records.addThread(uow, {
              id: joinId,
              sourceId: source.id,
              vibeId: vibe.id,
              threadId: landed.threadId,
              platformChannel: change.channel,
              platformThread: change.thread,
              url: change.url,
              sinceSeq: since,
              state: "active",
              createdBy: service.actorId,
              createdAt: now,
            });
          }
          this.records.addCopy(uow, {
            syncThreadId: joinId,
            messageId: landed.messageId,
            sourceId: source.id,
            direction: "in",
            platformMessage: change.message,
            url: change.url,
            state: "done",
            seq: since,
            attempts: 0,
            retryAt: null,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          });
        },
      });
      if (!joined) {
        await this.receipts.note(vibe.id, posted.messageId, "thread.synced", service.actorId, {
          source: source.key,
          target: formatTarget(source.key, labelOf(source.config, change.channel), change.thread),
          url: change.url,
        });
      }
      return null;
    } catch (error) {
      // Another delivery of the same message, or of its thread's first, got
      // there first. Its commit landed and this one wrote nothing.
      if (this.records.isTaken(error) || this.records.isDuplicate(error)) {
        return "It came in before.";
      }
      throw error;
    }
  }

  private async edit(
    opened: Opened,
    vibe: VibeRecord,
    service: Caller,
    platformMessage: string,
    text: string,
  ): Promise<Note> {
    const found = await this.theirs(opened, vibe, service, platformMessage);
    if (typeof found === "string") return found;
    await this.changer.edit({
      caller: found.author,
      vibe,
      messageId: found.messageId,
      text: await this.settle(opened, service, text),
      mentions: opened.platform.handlesMention ? undefined : "exact",
    });
    return null;
  }

  private async remove(
    opened: Opened,
    vibe: VibeRecord,
    service: Caller,
    platformMessage: string,
  ): Promise<Note> {
    const found = await this.theirs(opened, vibe, service, platformMessage);
    if (typeof found === "string") return found;
    await this.changer.delete({ caller: found.author, vibe, messageId: found.messageId });
    return null;
  }

  private async react(
    opened: Opened,
    vibe: VibeRecord,
    service: Caller,
    change: Extract<Inbound, { kind: "reaction" }>,
  ): Promise<Note> {
    const copy = await this.records.copyByPlatform(opened.context.source.id, change.message);
    if (!copy) return "The message isn't here.";
    const message = await this.messages.getMessage(vibe.id, copy.messageId);
    if (!message) return "The message is gone.";
    const refusal = await this.refused(service, vibe, message.channel);
    if (refusal) return refusal;
    await this.changer.react({
      caller: await this.actorFor(opened, service, change.author),
      vibe,
      messageId: copy.messageId,
      emoji: change.emoji,
      remove: change.remove,
    });
    return null;
  }

  /** Brings the root's labels in line with what the platform says of the thread. */
  private async state(
    opened: Opened,
    vibe: VibeRecord,
    service: Caller,
    change: Extract<Inbound, { kind: "state" }>,
  ): Promise<Note> {
    const joined = await this.records.threadByPlatform(opened.context.source.id, change.thread);
    if (!joined) return "Its thread isn't synced.";
    const root = await this.messages.getMessage(vibe.id, joined.threadId);
    if (!root || root.deletedAt !== null) return "Its thread is gone.";
    const refusal = await this.refused(service, vibe, root.channel);
    if (refusal) return refusal;

    const { set, unset } = platformLabelChange(root.labels, change.labels, change.owned);
    if (Object.keys(set).length === 0 && unset.length === 0) return "Nothing changed.";
    // Labels are the entry's own doing, not a platform user's: no one on the
    // platform set a label.
    await this.changer.label({ caller: service, vibe, messageId: root.id, change: { set, unset } });
    return null;
  }

  /**
   * The vibe message a platform message came in as, and its author as a
   * caller: an edit or a delete on the platform is theirs here too.
   */
  private async theirs(
    opened: Opened,
    vibe: VibeRecord,
    service: Caller,
    platformMessage: string,
  ): Promise<{ messageId: string; author: Caller } | string> {
    const copy = await this.records.copyByPlatform(opened.context.source.id, platformMessage);
    if (!copy) return "The message isn't here.";
    // What went out from the vibe is the vibe's to change, not the platform's.
    if (copy.direction === "out") return "It is a copy of a message written elsewhere.";
    const message = await this.messages.getMessage(vibe.id, copy.messageId);
    if (!message || message.deletedAt !== null) return "The message is gone.";
    if (message.by.principal !== service.principal || message.by.profile === null) {
      return "Its author isn't one of this entry's.";
    }
    const refusal = await this.refused(service, vibe, message.channel);
    if (refusal) return refusal;
    const author: Caller = {
      ...service,
      actorId: message.by.actor,
      profile: message.by.profile,
      handle: message.by.handle,
      name: message.by.name,
    };
    return { messageId: message.id, author };
  }

  /** Why the entry may not write in a channel, when it may not: its service holds no `sync` there. */
  private async refused(service: Caller, vibe: VibeRecord, channel: string): Promise<Note> {
    const can = await this.authorizer.permissions(service, { vibeId: vibe.id, channel });
    return can.has("sync") ? null : `The service ${service.handle} holds no sync in ${channel}.`;
  }

  /**
   * The caller a platform user writes as: a profile of the service, with an
   * actor of its own. Their first appearance introduces them, under their
   * name where the platform gives one.
   */
  private async actorFor(opened: Opened, service: Caller, user: PlatformUser): Promise<Caller> {
    const { source } = opened.context;
    const id = platformActorId(service.principal, source.key, user.id);
    const profile = platformProfile(source.key, user.id);
    let known = await this.actors.find(id);
    if (!known) {
      let named = user;
      if (user.name === null && opened.platform.describe) {
        // A name is a courtesy. Without one they go by their ID.
        named = await opened.platform.describe(opened.context, user.id).catch(() => user);
      }
      known = await this.actors.ensure(
        {
          id,
          teamId: service.teamId,
          principal: service.principal,
          profile,
          name: platformName(named),
          handles: platformHandles(service.handle, named),
        },
        this.clock.now(),
      );
    }
    return { ...service, actorId: id, profile, handle: known.handle, name: known.name };
  }

  /**
   * Makes a platform's text a vibe's. Each user the adapter found mentioned
   * becomes a mention of the actor that user is here. Nothing else in it
   * spells a mention out: the exact form, typed there, is broken with an
   * invisible space. Whether a handle in it mentions anyone is the platform's
   * to say, and whoever posts it is told. A text too long for a message is cut.
   */
  private async settle(opened: Opened, service: Caller, text: string): Promise<string> {
    const typed = text.replace(/@\[/g, "@\u200b[");
    const ids = [...new Set([...typed.matchAll(USER_MENTION)].map((match) => match[1] ?? ""))];
    const actors = new Map<string, string>();
    for (const id of ids.slice(0, MAX_LOOKUPS)) {
      const mentioned = await this.actorFor(opened, service, { id, name: null }).catch(() => null);
      if (mentioned) actors.set(id, mentioned.actorId);
    }
    const settled = typed.replace(USER_MENTION, (_, id: string) => {
      const actor = actors.get(id);
      return actor === undefined ? `@${id}` : `@[${actor}]`;
    });
    if (settled.length <= MAX_TEXT_LENGTH) return settled;
    return `${settled.slice(0, MAX_TEXT_LENGTH - CUT.length)}${CUT}`;
  }
}

/**
 * A webhook's body as the inbox keeps it: without the verification token
 * Slack still sends beside its signature, which is a credential of the app's.
 */
function redacted(body: string): string {
  if (!body.includes('"token"')) return body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body;
    const { token: _token, ...rest } = parsed as Record<string, unknown>;
    return JSON.stringify(rest);
  } catch {
    return body;
  }
}
