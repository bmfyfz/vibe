import { type Actor, VibeError, type VibeHandle } from "@vibe/sdk";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { bytes, mentionAt } from "../lib/text.ts";
import { ClipIcon, CloseIcon, TagIcon } from "./icons.tsx";

/** What a composer hands over to be posted. */
export interface Draft {
  text: string;
  /** IDs of the files that were uploaded for it. */
  attachments: string[];
  labels: Record<string, string>;
  noSync: boolean;
}

interface ComposerProps {
  handle: VibeHandle;
  actors: Actor[];
  /** What the text field is called, for whoever can't see it. */
  label: string;
  placeholder: string;
  submit: string;
  /** Whether you may put labels on what you post here. */
  canLabel: boolean;
  /** Where what is posted here also goes, when the thread is synced: the page says so, and offers to keep it here. */
  syncedWith?: string[] | undefined;
  autoFocus?: boolean | undefined;
  onSubmit(draft: Draft): Promise<void>;
  onCancel?: (() => void) | undefined;
}

interface Upload {
  key: number;
  name: string;
  size: number;
  /** The file's ID once it is uploaded. */
  id: string | null;
  error: string | null;
}

/** The key that posts with Enter, as this person's keyboard names it. Either works everywhere. */
const POST_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const MAX_FILES = 10;
const MAX_SUGGESTIONS = 6;
const LABEL = /^([a-z0-9][a-z0-9_.-]{0,63})=(.+)$/;

/**
 * Where a message is written: Markdown, with files, labels and mentions. A
 * handle typed after `@` is completed from the people and agents you can see.
 * Ctrl or Cmd with Enter posts.
 */
export function Composer(props: ComposerProps) {
  const { handle, actors, onSubmit } = props;
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [labels, setLabels] = useState("");
  const [labelling, setLabelling] = useState(false);
  const [noSync, setNoSync] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const counter = useRef(0);

  const mention = dismissed ? null : mentionAt(text, caret);
  const suggestions = useMemo(() => {
    if (mention === null) return [];
    return actors
      .filter(
        (actor) =>
          actor.handle.includes(mention.typed) || actor.name.toLowerCase().includes(mention.typed),
      )
      .sort(
        (a, b) =>
          Number(b.handle.startsWith(mention.typed)) - Number(a.handle.startsWith(mention.typed)),
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [actors, mention]);
  const suggesting = suggestions.length > 0;
  const active = Math.min(picked, suggestions.length - 1);

  function complete(actor: Actor) {
    if (mention === null) return;
    const next = `${text.slice(0, mention.start)}@${actor.handle} ${text.slice(caret)}`;
    const at = mention.start + actor.handle.length + 2;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(at, at);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggesting) {
      const chosen = suggestions[active];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setPicked((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.metaKey &&
        !event.ctrlKey &&
        chosen
      ) {
        event.preventDefault();
        complete(chosen);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void post();
    } else if (event.key === "Escape" && props.onCancel && text === "" && uploads.length === 0) {
      props.onCancel();
    }
  }

  function onText(event: ChangeEvent<HTMLTextAreaElement>) {
    setText(event.target.value);
    setCaret(event.target.selectionStart);
    setDismissed(false);
    setPicked(0);
  }

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const room = MAX_FILES - uploads.length;
    const taken = [...files].slice(0, room);
    if (files.length > room) setError(`A message carries up to ${MAX_FILES} files.`);
    for (const file of taken) {
      const key = ++counter.current;
      setUploads((before) => [
        ...before,
        { key, name: file.name, size: file.size, id: null, error: null },
      ]);
      try {
        const uploaded = await handle.upload({
          name: file.name,
          data: file,
          type: file.type || undefined,
        });
        setUploads((before) =>
          before.map((each) => (each.key === key ? { ...each, id: uploaded.id } : each)),
        );
      } catch (failure) {
        const why = failure instanceof VibeError ? failure.message : "The upload failed.";
        setUploads((before) =>
          before.map((each) => (each.key === key ? { ...each, error: why } : each)),
        );
      }
    }
    if (picker.current) picker.current.value = "";
  }

  /** Reads `key=value` pairs, separated by spaces or commas. */
  function parsedLabels(): Record<string, string> | string {
    const out: Record<string, string> = {};
    for (const part of labels.split(/[\s,]+/).filter(Boolean)) {
      const match = LABEL.exec(part);
      if (!match?.[1] || match[2] === undefined)
        return `"${part}" is not a label. Write it as key=value, such as state=open.`;
      out[match[1]] = match[2];
    }
    return out;
  }

  const uploading = uploads.some((each) => each.id === null && each.error === null);
  const ready = uploads.filter((each) => each.id !== null);
  const empty = text.trim() === "" && ready.length === 0;

  async function post(event?: FormEvent) {
    event?.preventDefault();
    if (busy || uploading) return;
    if (empty) {
      setError("Write something, or attach a file.");
      field.current?.focus();
      return;
    }
    const set = parsedLabels();
    if (typeof set === "string") {
      setError(set);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        text,
        attachments: ready.flatMap((each) => (each.id === null ? [] : [each.id])),
        labels: set,
        noSync,
      });
      setText("");
      setUploads([]);
      setLabels("");
      setLabelling(false);
      setNoSync(false);
    } catch (failure) {
      const hint = failure instanceof VibeError && failure.hint ? ` ${failure.hint}` : "";
      setError(failure instanceof Error ? `${failure.message}${hint}` : "It could not be posted.");
    } finally {
      setBusy(false);
    }
  }

  const listId = `${id}-suggestions`;
  return (
    <form className="composer" onSubmit={post}>
      <label className="visually-hidden" htmlFor={`${id}-text`}>
        {props.label}
      </label>
      <div className="composer-field">
        <textarea
          id={`${id}-text`}
          ref={field}
          value={text}
          rows={3}
          placeholder={props.placeholder}
          // biome-ignore lint/a11y/noAutofocus: the composer opens because the person asked to write
          autoFocus={props.autoFocus}
          onChange={onText}
          onKeyDown={onKeyDown}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggesting}
          aria-controls={suggesting ? listId : undefined}
          aria-activedescendant={suggesting ? `${listId}-${active}` : undefined}
          aria-describedby={`${id}-help`}
        />
        {suggesting && (
          // The field keeps the keyboard. The list is pointed at, with aria-activedescendant.
          <div className="suggestions" id={listId} role="listbox" aria-label="People and agents">
            {suggestions.map((actor, index) => (
              <div
                key={actor.actor}
                id={`${listId}-${index}`}
                className="suggestion"
                role="option"
                tabIndex={-1}
                aria-selected={index === active}
                // Pressed, not clicked: the field keeps the caret where the handle goes.
                onMouseDown={(event) => {
                  event.preventDefault();
                  complete(actor);
                }}
              >
                <span className="suggestion-handle">@{actor.handle}</span>
                <span className="suggestion-name">{actor.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {uploads.length > 0 && (
        <ul className="uploads" aria-label="Files to attach">
          {uploads.map((file) => (
            <li key={file.key} className="upload" data-error={file.error !== null || undefined}>
              <span className="upload-name">{file.name}</span>
              <span className="upload-state">
                {file.error ?? (file.id === null ? "Uploading…" : bytes(file.size))}
              </span>
              <button
                type="button"
                className="icon-button"
                onClick={() =>
                  setUploads((before) => before.filter((each) => each.key !== file.key))
                }
              >
                <CloseIcon />
                <span className="visually-hidden">Remove {file.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {props.canLabel && labelling && (
        <div className="composer-labels">
          <label htmlFor={`${id}-labels`}>Labels</label>
          <input
            id={`${id}-labels`}
            type="text"
            value={labels}
            placeholder="state=open kind=bug"
            spellCheck={false}
            autoComplete="off"
            // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked to add labels
            autoFocus
            onChange={(event) => setLabels(event.target.value)}
          />
        </div>
      )}

      {props.syncedWith && props.syncedWith.length > 0 && (
        <label className="check">
          <input
            type="checkbox"
            checked={noSync}
            onChange={(event) => setNoSync(event.target.checked)}
          />
          <span>
            Keep this message on the vibe. Otherwise it also goes to {props.syncedWith.join(", ")}.
          </span>
        </label>
      )}

      {error !== null && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}

      <div className="composer-actions">
        <input
          ref={picker}
          type="file"
          multiple
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => void addFiles(event.target.files)}
        />
        <button
          type="button"
          className="button quiet"
          onClick={() => picker.current?.click()}
          disabled={uploads.length >= MAX_FILES}
        >
          <ClipIcon />
          Attach
        </button>
        {props.canLabel && (
          <button
            type="button"
            className="button quiet"
            aria-expanded={labelling}
            onClick={() => setLabelling(!labelling)}
          >
            <TagIcon />
            Labels
          </button>
        )}
        <span id={`${id}-help`} className="composer-help">
          Markdown. <kbd>@</kbd> mentions. <kbd>{POST_KEY}</kbd>+<kbd>Enter</kbd> posts.
        </span>
        {props.onCancel && (
          <button type="button" className="button quiet" onClick={props.onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="button primary" disabled={busy || uploading}>
          {busy ? "Posting…" : props.submit}
        </button>
      </div>
    </form>
  );
}
