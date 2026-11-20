import {
  type Message,
  type Permission,
  type SyncFailure,
  VibeError,
  type VibeHandle,
} from "@vibe/sdk";
import { type FormEvent, useId, useState } from "react";

import { glyph, OFFERED, spoken } from "../lib/emoji.ts";
import { bytes, who } from "../lib/text.ts";
import { ago, exact } from "../lib/time.ts";
import { CloseIcon, DownloadIcon, EditIcon, ReactIcon, TagIcon, TrashIcon } from "./icons.tsx";
import { Markdown } from "./markdown.tsx";

interface MessageProps {
  handle: VibeHandle;
  message: Message;
  /** Who is reading: their principal, and the actor they write as. */
  me: { principal: string; actor: string } | null;
  can: ReadonlySet<Permission>;
  /** The deliveries of this message to a synced platform that failed. */
  failures: SyncFailure[];
  root: boolean;
  onChanged(): Promise<void>;
}

const IMAGE = /^image\/(png|jpeg|gif|webp|avif)$/;
const LABEL = /^([a-z0-9][a-z0-9_.-]{0,63})=(.+)$/;

/** What a refusal says, in the API's own words. */
const said = (error: unknown) =>
  error instanceof VibeError
    ? [error.message, error.hint].filter(Boolean).join(" ")
    : "That didn't go through. Try again.";

/**
 * One message of a thread: who wrote it and through whom, where it came from,
 * what it says, and what sits on it: files, labels, reactions. What the
 * reader can't do to it isn't offered.
 */
export function MessageView({ handle, message, me, can, failures, root, onChanged }: MessageProps) {
  const id = useId();
  const [mode, setMode] = useState<"read" | "edit" | "label" | "react" | "delete">("read");
  const [draft, setDraft] = useState("");
  // The revision the editor was opened on. A draft is a change to that text,
  // and is refused once someone else has changed it since.
  const [opened, setOpened] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleted = message.deletedAt !== null;
  // You change what you wrote, and what your agents wrote under your name.
  const mine = me !== null && message.by.principal === me.principal;
  // The vibe's own labels, such as a task's state, are shown where they mean
  // something: in the task's panel, not again as a label nobody can change.
  // A thread's `state` is in the box at its head, so its root doesn't say it
  // again, except while labels are being changed, when it can be taken off.
  const stated = root && message.labels["vibe.task"] === undefined && mode !== "label";
  const labels = Object.entries(message.labels).filter(
    ([key]) => !key.startsWith("vibe.") && !(stated && key === "state"),
  );

  /**
   * Does one thing to the message, says so if it was refused, and reads the
   * thread again. What was open for it closes, unless the reader has opened
   * something else on the message while it was under way.
   */
  async function act(work: () => Promise<unknown>) {
    const during = mode;
    setBusy(true);
    setError(null);
    try {
      await work();
      setMode((now) => (now === during ? "read" : now));
      await onChanged();
    } catch (failure) {
      setError(said(failure));
    } finally {
      setBusy(false);
    }
  }

  const reacted = (emoji: string) =>
    message.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.by.some((by) => by.actor === me?.actor),
    );
  const react = (emoji: string) =>
    act(() => handle.react(message.id, emoji, { remove: reacted(emoji) }));

  function saveLabel(event: FormEvent) {
    event.preventDefault();
    const match = LABEL.exec(draft.trim());
    if (!match?.[1] || match[2] === undefined) {
      setError("Write a label as key=value, such as state=open.");
      return;
    }
    const [, key, value] = match;
    void act(() => handle.label(message.id, { set: { [key]: value } }));
  }

  if (deleted) {
    return (
      <article className="message tombstone" id={message.id}>
        <header className="message-head">
          <span className="message-who">{who(message.by)}</span>
          <span className="message-meta">
            deleted {ago(message.deletedAt ?? message.createdAt)} ago
          </span>
        </header>
      </article>
    );
  }

  return (
    <article
      className="message"
      id={message.id}
      data-root={root || undefined}
      aria-labelledby={`${id}-who`}
    >
      <header className="message-head">
        <span className="message-who" id={`${id}-who`}>
          {who(message.by)}
        </span>
        {message.from !== "vibe" && (
          <span className="origin" title={`Written on ${message.from}, and synced here`}>
            {message.from}
          </span>
        )}
        {message.noSync && (
          <span className="origin kept" title="Kept off every synced platform">
            vibe only
          </span>
        )}
        <span className="message-meta">
          <time dateTime={message.createdAt} title={exact(message.createdAt)}>
            {ago(message.createdAt)}
          </time>
          {message.revision > 1 && " · edited"}
        </span>
        <span className="message-tools">
          {can.has("react") && (
            <button
              type="button"
              className="icon-button"
              aria-expanded={mode === "react"}
              onClick={() => setMode(mode === "react" ? "read" : "react")}
            >
              <ReactIcon />
              <span className="visually-hidden">React</span>
            </button>
          )}
          {can.has("label") && (
            <button
              type="button"
              className="icon-button"
              aria-expanded={mode === "label"}
              onClick={() => {
                setDraft("");
                setMode(mode === "label" ? "read" : "label");
              }}
            >
              <TagIcon />
              <span className="visually-hidden">Add a label</span>
            </button>
          )}
          {mine && can.has("post") && (
            <>
              <button
                type="button"
                className="icon-button"
                onClick={() => {
                  setDraft(textForEditing(message));
                  setOpened(message.revision);
                  setMode("edit");
                }}
              >
                <EditIcon />
                <span className="visually-hidden">Edit</span>
              </button>
              <button type="button" className="icon-button" onClick={() => setMode("delete")}>
                <TrashIcon />
                <span className="visually-hidden">Delete</span>
              </button>
            </>
          )}
        </span>
      </header>

      {mode === "edit" ? (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => handle.edit(message.id, draft, { revision: opened }));
          }}
        >
          <label className="visually-hidden" htmlFor={`${id}-edit`}>
            Edit message
          </label>
          <textarea
            id={`${id}-edit`}
            value={draft}
            rows={Math.min(12, Math.max(3, draft.split("\n").length + 1))}
            // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked to edit
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setMode("read");
            }}
          />
          <div className="inline-actions">
            <button type="button" className="button quiet" onClick={() => setMode("read")}>
              Cancel
            </button>
            <button type="submit" className="button primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      ) : (
        message.text !== "" && <Markdown message={message} />
      )}

      {message.blocks.map((block, index) => (
        // A message's data has no name but its place on the message.
        // biome-ignore lint/suspicious/noArrayIndexKey: the place is the identity
        <details className="block" key={index}>
          <summary>
            {block.schema}@{block.version}
          </summary>
          <pre>{JSON.stringify(block.data, null, 2)}</pre>
        </details>
      ))}

      {message.attachments.length > 0 && (
        <ul className="files" aria-label="Files">
          {message.attachments.map((file) => {
            const href = handle.attachmentUrl(file.id);
            return (
              <li key={file.id} className="file-row">
                {IMAGE.test(file.type) && (
                  <a href={href} className="file-preview" download={file.name}>
                    <img src={href} alt={file.name} loading="lazy" />
                  </a>
                )}
                <a href={href} className="file" download={file.name}>
                  <DownloadIcon />
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{bytes(file.size)}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {(labels.length > 0 || mode === "label") && (
        <ul className="labels" aria-label="Labels">
          {labels.map(([key, value]) => (
            <li key={key} className="label">
              {key}={value}
              {can.has("label") && !key.startsWith("vibe.") && (
                <button
                  type="button"
                  className="label-remove"
                  disabled={busy}
                  onClick={() => void act(() => handle.label(message.id, { unset: [key] }))}
                >
                  <CloseIcon />
                  <span className="visually-hidden">Remove the label {key}</span>
                </button>
              )}
            </li>
          ))}
          {mode === "label" && (
            <li>
              <form className="label-form" onSubmit={saveLabel}>
                <label className="visually-hidden" htmlFor={`${id}-label`}>
                  Label, as key=value
                </label>
                <input
                  id={`${id}-label`}
                  type="text"
                  value={draft}
                  placeholder="key=value"
                  spellCheck={false}
                  autoComplete="off"
                  // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked to add a label
                  autoFocus
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setMode("read");
                  }}
                />
                <button type="submit" className="button small" disabled={busy}>
                  Add
                </button>
              </form>
            </li>
          )}
        </ul>
      )}

      {(message.reactions.length > 0 || mode === "react") && (
        <div className="reactions">
          {message.reactions.map((reaction) => (
            <button
              key={reaction.emoji}
              type="button"
              className="reaction"
              aria-pressed={reacted(reaction.emoji)}
              disabled={busy || !can.has("react")}
              title={reaction.by.map((by) => by.handle).join(", ")}
              onClick={() => void react(reaction.emoji)}
            >
              <span aria-hidden="true">{glyph(reaction.emoji)}</span>
              <span className="visually-hidden">{spoken(reaction.emoji)},</span>
              <span className="reaction-count">{reaction.by.length}</span>
            </button>
          ))}
          {mode === "react" && (
            <fieldset className="reaction-picker">
              <legend className="visually-hidden">React with</legend>
              {OFFERED.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="reaction pick"
                  aria-pressed={reacted(emoji)}
                  disabled={busy}
                  onClick={() => void react(emoji)}
                >
                  <span aria-hidden="true">{glyph(emoji)}</span>
                  <span className="visually-hidden">{spoken(emoji)}</span>
                </button>
              ))}
            </fieldset>
          )}
        </div>
      )}

      {mode === "delete" && (
        <div className="notice danger confirm" role="alertdialog" aria-labelledby={`${id}-delete`}>
          <p id={`${id}-delete`}>
            Delete this message? It leaves a marker in its place, and{" "}
            {root ? "the replies stay" : "the thread stays"}.
          </p>
          <div className="inline-actions">
            <button
              type="button"
              className="button quiet"
              // biome-ignore lint/a11y/noAutofocus: the safe answer is where the keyboard lands
              autoFocus
              onClick={() => setMode("read")}
            >
              Keep it
            </button>
            <button
              type="button"
              className="button danger"
              disabled={busy}
              onClick={() =>
                void act(() => handle.delete(message.id, { revision: message.revision }))
              }
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {failures.map((failure) => (
        <p className="notice warn" key={failure.target}>
          Not delivered to {failure.target}: {failure.error ?? "the platform refused it"}
        </p>
      ))}
      {error !== null && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** A message's text as its author wrote it: mentions by handle, not by the ID they were stored as. */
function textForEditing(message: Message): string {
  let text = message.text;
  for (const mention of message.mentions) {
    text = text.replaceAll(`@[${mention.actor}]`, `@${mention.handle}`);
  }
  return text;
}
