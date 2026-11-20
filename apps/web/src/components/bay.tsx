import type { Actor, Channel, ThreadSummary, VibeHandle } from "@vibe/sdk";
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react";

import { shownLabels, stateOf } from "../lib/holder.ts";
import { firstLines, who } from "../lib/text.ts";
import { ago, exact, milliseconds } from "../lib/time.ts";
import type { Filters } from "../state/use-vibe.ts";
import { Composer, type Draft } from "./composer.tsx";
import { MenuIcon, PlusIcon } from "./icons.tsx";

interface BayProps {
  handle: VibeHandle;
  /** The pattern that is listed: a channel, a subtree, or `null` for all. */
  channel: string | null;
  channels: Channel[];
  actors: Actor[];
  threads: ThreadSummary[] | null;
  /** The root of the thread that is open. */
  open: string | null;
  unseen: ReadonlySet<string>;
  filters: Filters;
  /** Whether you may post in what is listed: somewhere in it, when it is more than one channel. */
  canPost: boolean;
  canLabel: boolean;
  hrefOf(threadId: string): string;
  onOpen(threadId: string): void;
  onFilters(filters: Filters): void;
  onPosted(threadId: string): void;
  onMenu(): void;
}

/**
 * The bay: a channel's threads as strips, the one that moved last on top. A
 * strip that moves keeps its place in the page's memory and slides to where
 * it belongs, so the eye follows it instead of losing it.
 */
export function Bay(props: BayProps) {
  const { channel, threads, filters } = props;
  const [writing, setWriting] = useState(false);
  const exactChannel = channel !== null && !channel.endsWith("/") ? channel : null;
  const title = channel === null ? "All channels" : channel;
  const list = useSlide(
    threads?.map((thread) => thread.message.id) ?? [],
    `${channel ?? ""}\n${filters.mentions}\n${filters.tasks}`,
  );

  function onListKey(event: KeyboardEvent<HTMLOListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = [...event.currentTarget.querySelectorAll<HTMLElement>("a.strip")];
    const at = links.indexOf(document.activeElement as HTMLElement);
    const next = links[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  return (
    <section className="bay" aria-label="Threads">
      <header className="bay-head">
        <button type="button" className="icon-button menu-button" onClick={props.onMenu}>
          <MenuIcon />
          <span className="visually-hidden">Channels</span>
        </button>
        <h1 className="bay-title">
          {title.split("/").map((part, index, parts) => (
            // A path reads as a path: its last part is the channel, the rest is where it sits.
            <span
              key={parts.slice(0, index + 1).join("/")}
              className={index === parts.length - 1 ? "leaf" : "stem"}
            >
              {part}
              {index < parts.length - 1 && "/"}
            </span>
          ))}
        </h1>
        {props.canPost && (
          <button
            type="button"
            className="button primary"
            onClick={() => setWriting(true)}
            disabled={writing}
          >
            <PlusIcon />
            New thread
          </button>
        )}
      </header>

      <fieldset className="bay-filters">
        <legend className="visually-hidden">Show</legend>
        <Toggle
          label="Mentions you"
          pressed={filters.mentions}
          onChange={(mentions) => props.onFilters({ ...filters, mentions })}
        />
        <Toggle
          label="Tasks"
          pressed={filters.tasks}
          onChange={(tasks) => props.onFilters({ ...filters, tasks })}
        />
      </fieldset>

      {writing && (
        <NewThread
          {...props}
          channel={exactChannel}
          onDone={(id) => {
            setWriting(false);
            if (id) props.onPosted(id);
          }}
        />
      )}

      {threads === null ? (
        <ol className="strips" aria-busy="true" aria-label="Loading threads">
          {[0, 1, 2, 3].map((n) => (
            <li key={n} className="strip skeleton" aria-hidden="true" />
          ))}
        </ol>
      ) : threads.length === 0 ? (
        <Empty filters={filters} channel={exactChannel} canPost={props.canPost} />
      ) : (
        <ol className="strips" ref={list} onKeyDown={onListKey}>
          {threads.map((thread) => (
            <Strip
              key={thread.message.id}
              thread={thread}
              href={props.hrefOf(thread.message.id)}
              open={props.open === thread.message.id}
              unseen={props.unseen.has(thread.message.id)}
              showChannel={exactChannel === null}
              onOpen={props.onOpen}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function Toggle(props: { label: string; pressed: boolean; onChange(pressed: boolean): void }) {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={props.pressed}
      onClick={() => props.onChange(!props.pressed)}
    >
      {props.label}
    </button>
  );
}

function Empty(props: { filters: Filters; channel: string | null; canPost: boolean }) {
  const filtered = props.filters.mentions || props.filters.tasks;
  return (
    <div className="empty">
      {filtered ? (
        <p>Nothing here matches. Turn a filter off to see every thread.</p>
      ) : props.channel === null ? (
        <p>
          No threads yet. A thread starts with a post in a channel, from here or from an agent:{" "}
          <code>vibe post dev "is the deploy done?"</code>
        </p>
      ) : (
        <p>
          Nothing has been posted in <strong>{props.channel}</strong> yet.
          {props.canPost ? " Start a thread, and it will show up here." : ""}
        </p>
      )}
    </div>
  );
}

interface StripProps {
  thread: ThreadSummary;
  href: string;
  open: boolean;
  unseen: boolean;
  showChannel: boolean;
  onOpen(id: string): void;
}

/** One thread, on one strip: its state in the first box, then who, what, and how it stands. */
function Strip({ thread, href, open, unseen, showChannel, onOpen }: StripProps) {
  const { message, replies, last } = thread;
  const state = stateOf(message);
  const labels = shownLabels(message);
  const deleted = message.deletedAt !== null;
  const latest = last ?? message;
  return (
    <li className="strip-slot" data-key={message.id}>
      <a
        className="strip"
        href={href}
        aria-current={open ? "true" : undefined}
        data-unseen={unseen || undefined}
        onClick={(event) => {
          // A plain click opens it here. Anything else is the browser's: a new tab, a new window.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          onOpen(message.id);
        }}
      >
        <span className="strip-state" data-holder={state?.holder}>
          {state ? state.word.replaceAll("_", " ") : ""}
        </span>
        <span className="strip-body">
          <span className="strip-line">
            <span className="strip-who">{who(message.by)}</span>
            {message.from !== "vibe" && <span className="origin">{message.from}</span>}
            {showChannel && <span className="strip-channel">{message.channel}</span>}
            <time
              className="strip-time"
              dateTime={latest.createdAt}
              title={exact(latest.createdAt)}
            >
              {ago(latest.createdAt)}
            </time>
          </span>
          <span className="strip-text">
            {deleted ? <em>Deleted</em> : firstLines(message) || <em>No text</em>}
          </span>
          {(labels.length > 0 || replies > 0) && (
            <span className="strip-line foot">
              {labels.slice(0, 4).map(([key, value]) => (
                <span key={key} className="label">
                  {key}={value}
                </span>
              ))}
              {labels.length > 4 && <span className="label more">+{labels.length - 4}</span>}
              {replies > 0 && last && (
                <span className="strip-replies">
                  {replies} {replies === 1 ? "reply" : "replies"}, last from {who(last.by)}
                </span>
              )}
            </span>
          )}
        </span>
        {unseen && (
          <span className="unseen">
            <span className="visually-hidden">New activity</span>
          </span>
        )}
      </a>
    </li>
  );
}

/** Starting a thread. In a channel it posts there; above one, it asks which. */
function NewThread(props: BayProps & { onDone(threadId: string | null): void }) {
  const id = useId();
  const [channel, setChannel] = useState("");

  async function post(draft: Draft) {
    const where = (props.channel ?? channel).trim();
    if (where === "") throw new Error("Say which channel the thread goes in.");
    const posted = await props.handle.post(where, draft.text, {
      attachments: draft.attachments,
      labels: Object.keys(draft.labels).length > 0 ? draft.labels : undefined,
    });
    props.onDone(posted.id);
  }

  return (
    <div className="new-thread">
      {props.channel === null && (
        <div className="composer-labels">
          <label htmlFor={`${id}-channel`}>Channel</label>
          <input
            id={`${id}-channel`}
            type="text"
            list={`${id}-channels`}
            value={channel}
            placeholder="dev, or www/production"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setChannel(event.target.value)}
          />
          <datalist id={`${id}-channels`}>
            {props.channels.map((each) => (
              <option key={each.path} value={each.path} />
            ))}
          </datalist>
        </div>
      )}
      <Composer
        handle={props.handle}
        actors={props.actors}
        label="New thread"
        placeholder="Start a thread. The first line is what the list shows."
        submit="Post"
        canLabel={props.canLabel}
        autoFocus={props.channel !== null}
        onSubmit={post}
        onCancel={() => props.onDone(null)}
      />
    </div>
  );
}

/**
 * Slides list items to their new places when their order changes: each is
 * drawn where it was, then let go, and the one on its way up travels over the
 * ones it passes. People who ask for less motion get none.
 *
 * Where each item sits is read after every render, so a form that opened
 * above the list, or a strip that grew a line, is not mistaken for a move.
 *
 * @param listing What is listed. A different listing is a different list, not the same one reordered.
 */
function useSlide(keys: readonly string[], listing: string) {
  const list = useRef<HTMLOListElement>(null);
  const seen = useRef({ listing, order: "", tops: new Map<string, number>() });
  const order = keys.join("\n");

  // No dependencies: where things sit is read after every render, on purpose.
  useLayoutEffect(() => {
    const element = list.current;
    const before = seen.current;
    const tops = new Map<string, number>();
    seen.current = { listing, order, tops };
    if (!element) return;
    const moved = before.listing === listing && before.order !== order;
    const style = getComputedStyle(element);
    const duration = milliseconds(style.getPropertyValue("--move"), 200);
    const easing = style.getPropertyValue("--ease").trim() || "ease-out";
    for (const item of element.querySelectorAll<HTMLElement>(":scope > li")) {
      const key = item.dataset["key"] ?? "";
      // Against the list's own top, so what sits above the list moves nothing.
      const top = item.offsetTop - element.offsetTop;
      tops.set(key, top);
      const was = before.tops.get(key);
      // Under reduced motion the duration is a millisecond, which is no travel at all.
      if (!moved || duration < 20 || was === undefined || was === top || !item.animate) continue;
      const rising = was > top;
      if (rising) item.style.zIndex = "1";
      const slide = item.animate(
        [{ transform: `translateY(${was - top}px)` }, { transform: "translateY(0)" }],
        { duration, easing },
      );
      const settle = () => item.style.removeProperty("z-index");
      slide.addEventListener("finish", settle);
      slide.addEventListener("cancel", settle);
    }
  });
  return list;
}
