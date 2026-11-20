import type { PlatformUser } from "../domain/platform-user.ts";
import type { Credentials, Mapping, PlatformKind, Source, SourceConfig } from "../domain/source.ts";
import type { Place } from "../domain/target.ts";

/** How Vibe reaches another server. `fetch`, where nothing else is given. */
export type Send = (url: string, init: RequestInit) => Promise<Response>;

/** A webhook as it arrived: its headers, and its body exactly as sent, which is what was signed. */
export interface RawWebhook {
  readonly headers: Headers;
  readonly body: string;
}

/** What a sync entry acts with on its platform. */
export interface PlatformContext {
  readonly source: Source;
  readonly credentials: Credentials;
  readonly send: Send;
}

/** What a channel is mapped to, as whoever sets an entry up writes it. */
export type MapInput =
  | string
  | {
      /** The vibe channel for everything the platform channel holds. */
      channel?: string | undefined;
      /** On GitHub: the vibe channel for a repository's pull requests. */
      pulls?: string | undefined;
      /** On GitHub: the vibe channel for a repository's issues. */
      issues?: string | undefined;
      /** On GitHub: send replies written on the vibe back as comments. Off, unless said. */
      replies?: boolean | undefined;
    };

/** What a platform says of the credentials an entry holds. */
export interface Identity {
  /** Who they act as on the platform, by the platform's IDs. */
  self: Record<string, string>;
  /** Whether a message can go out under its author's name. */
  customize: boolean;
}

/** A message that arrived on a platform, or a thread's first message. */
export interface InboundMessage {
  readonly kind: "message";
  /** The platform channel it is in. */
  readonly channel: string;
  /** On GitHub, whether its thread is a pull request or an issue. */
  readonly only?: "pulls" | "issues";
  /** The platform thread it belongs to. */
  readonly thread: string;
  /** The platform's ID for the message. For a thread's first message, the thread's own. */
  readonly message: string;
  /** Whether it starts its thread. */
  readonly root: boolean;
  readonly author: PlatformUser;
  /**
   * Markdown. A mention of a platform user is written with `userMention`,
   * for whoever brings the message in to settle on the actor that user is
   * here. Nothing typed on a platform can read as one.
   */
  readonly text: string;
  /** The platform's link to the message. */
  readonly url: string | null;
  /** On a thread's first message: the platform's state, as labels for the root. */
  readonly labels?: Readonly<Record<string, string>>;
}

export type Inbound =
  | InboundMessage
  | { readonly kind: "edit"; readonly message: string; readonly text: string }
  | { readonly kind: "delete"; readonly message: string }
  | {
      readonly kind: "reaction";
      readonly message: string;
      readonly author: PlatformUser;
      readonly emoji: string;
      readonly remove: boolean;
    }
  | {
      /** The platform's state changed: the root's labels are to say so. */
      readonly kind: "state";
      readonly thread: string;
      /** What the platform says now. */
      readonly labels: Readonly<Record<string, string>>;
      /** The keys, and key prefixes ending in `.`, that this change decides: those it doesn't give are removed. */
      readonly owned: readonly string[];
    };

/** What a platform made of one webhook. */
export interface Received {
  /** The platform's ID for the delivery, the same when it sends it again. */
  readonly deliveryId: string;
  /** What kind of event it is, in the platform's words, such as `pull_request.opened`. */
  readonly event: string;
  /** What to answer with, when the platform asks a question instead of telling of an event. */
  readonly answer?: { readonly body: string; readonly contentType: string };
  /** What the event changes, in order. Empty for an event that changes nothing here. */
  readonly changes: readonly Inbound[];
  /** Why it changes nothing, when it doesn't. */
  readonly note?: string;
}

/** Someone a message mentions, as a platform is told of them. */
export interface OutgoingMention {
  /** The actor's ID, which the text holds as `@[actor-id]`. */
  readonly actor: string;
  readonly name: string;
  /** Their ID on this entry's platform, when this entry brought them in. */
  readonly platformUser: string | null;
}

/** A message on its way to a platform. */
export interface Outgoing {
  /** The vibe message's ID. */
  readonly id: string;
  /** Markdown, with each mention still written `@[actor-id]`. */
  readonly text: string;
  readonly mentions: readonly OutgoingMention[];
  /** Who wrote it, as the vibe shows them: `Ada`, or `fx via ada`. */
  readonly author: string;
  /** The names of the files it carries. The files themselves stay on the vibe. */
  readonly files: readonly string[];
  /**
   * The ID the platform is to give the message, where the platform takes one:
   * it is on record before the call, so the platform's own news of the
   * message is known for an echo however early it arrives.
   */
  readonly mint: string | null;
}

/** A platform thread, as a delivery names it. */
export interface ThreadRef {
  readonly channel: string;
  readonly thread: string;
}

/** What a platform made of a message it accepted. */
export interface Sent {
  /** The platform's ID for the copy. */
  readonly message: string;
  readonly url: string | null;
}

/**
 * One platform: how its webhooks are verified and read, and how messages are
 * written to it. Everything that knows Slack, GitHub or Linear is behind
 * this, so the rest of sync is the same for all three.
 */
export interface Platform {
  readonly kind: PlatformKind;
  /** Whether a new thread in a mapped vibe channel starts a thread on the platform. */
  readonly startsThreads: boolean;
  /**
   * Whether a handle typed on the platform, such as `@ada`, mentions whoever
   * has it on the vibe. Yes where only an organisation's own people write,
   * so that someone in Slack can ask an agent by name. No where anyone may
   * write: on a public repository, a stranger would page whom they pleased.
   */
  readonly handlesMention: boolean;

  /**
   * Settles a new entry: reads its mappings, and asks the platform who the
   * credentials are, which also proves they work.
   *
   * @throws `invalid_source` for a mapping or a credential that can't be
   *   used, and `platform_unavailable` when the platform can't be asked.
   */
  connect(input: {
    credentials: Credentials;
    map: Readonly<Record<string, MapInput>>;
    api: string | undefined;
    send: Send;
  }): Promise<SourceConfig>;

  /**
   * Asks the platform who a set of credentials is: how the entry's own writes
   * are told apart from everyone's, and whether it may post under an author's
   * name. Asking also proves a token works, which is why it is asked again
   * whenever an entry is given another.
   */
  identify(input: { credentials: Credentials; api: string; send: Send }): Promise<Identity>;

  /**
   * Checks that a webhook is the platform's, by the signature it carries.
   *
   * @throws `webhook_refused` when the signature is missing, wrong or too old.
   */
  verify(request: RawWebhook, credentials: Credentials, now: number): Promise<void>;

  /** Reads a verified webhook into what it changes. */
  read(request: RawWebhook, source: Source): Received;

  /** Whether a message of a synced thread goes out to this platform thread. */
  sends(mapping: Mapping | null, message: { root: boolean; from: string }): boolean;

  /**
   * What the rest of a target means on this platform: a channel to start a
   * thread in, or a thread to join.
   *
   * @throws `invalid_target` when it is neither.
   */
  place(context: PlatformContext, rest: string): Promise<Place>;

  /** A platform user's name, for a platform whose events carry only their ID. */
  describe?(context: PlatformContext, userId: string): Promise<PlatformUser>;

  /** A thread's first message, for a reply whose thread is not known here yet. */
  root?(context: PlatformContext, channel: string, thread: string): Promise<InboundMessage | null>;

  /** An ID for a message that is about to be sent, where the platform takes one. */
  mint?(): string;

  /** Starts a thread in a channel with a message. */
  start(context: PlatformContext, channel: string, message: Outgoing): Promise<Sent & ThreadRef>;

  /** Writes a message into a thread. */
  reply(context: PlatformContext, thread: ThreadRef, message: Outgoing): Promise<Sent>;

  /** Replaces the text of a copy. Best effort: a platform that can't, doesn't. */
  edit?(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
    message: Outgoing,
  ): Promise<void>;

  /** Removes a copy. */
  remove?(context: PlatformContext, thread: ThreadRef, platformMessage: string): Promise<void>;

  /** Adds the entry's reaction to a message on the platform, or takes it back. */
  react?(
    context: PlatformContext,
    thread: ThreadRef,
    platformMessage: string,
    emoji: string,
    remove: boolean,
  ): Promise<void>;
}

export type Platforms = Readonly<Record<PlatformKind, Platform>>;

// A mention an adapter found sits between two characters that are stripped
// from everything a platform sends before an adapter reads it. So text typed
// on a platform can't pass for one, whatever it spells.
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";

/** A mention of a platform user, by the platform's ID, as an adapter writes it into a message's text. */
export function userMention(platformUser: string): string {
  return `${MARK_OPEN}${platformUser}${MARK_CLOSE}`;
}

/** Finds each mention an adapter wrote. Its one group is the platform's ID of the user. */
export const USER_MENTION = /\uE000([^\uE000\uE001\s]{1,100})\uE001/g;

/** A webhook's body without the two marking characters, as they are or as JSON escapes them. */
export function withoutMarks(body: string): string {
  return body.replace(/[\uE000\uE001]|\\u[eE]00[01]/g, "");
}

/** Rewrites what in a Markdown text is prose, leaving code blocks and code spans as they are. */
export function outsideCode(text: string, change: (prose: string) => string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) => (index % 2 === 1 ? part : change(part)))
    .join("");
}

/**
 * Writes a message's text for a platform: each `@[actor-id]` as the
 * platform's own mention when the actor is one of the platform's users that
 * this entry brought in, and as their name in plain text otherwise. A name is
 * never written with `@`: on another platform it could page a stranger.
 *
 * @param quiet Takes from the message's prose what the platform would read as
 *   a mention of its own, such as `@login` or `<!channel>`. What is written on
 *   a vibe pages nobody on a platform but the people this entry brought in.
 */
export function renderMentions(
  message: Outgoing,
  native: (platformUser: string, name: string) => string,
  quiet: (prose: string) => string = (prose) => prose,
): string {
  const byActor = new Map(message.mentions.map((mention) => [mention.actor, mention]));
  return outsideCode(message.text, quiet).replace(
    /@\[([^\]\s]{1,200})\]/g,
    (written, actor: string) => {
      const mention = byActor.get(actor);
      if (!mention) return written;
      return mention.platformUser === null
        ? mention.name
        : native(mention.platformUser, mention.name);
    },
  );
}
