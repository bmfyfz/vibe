import {
  type Actor,
  type Permission,
  type Task,
  type ThreadDetail,
  VibeError,
  type VibeHandle,
  type Whoami,
} from "@vibe/sdk";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { stateOf } from "../lib/holder.ts";
import { who } from "../lib/text.ts";
import { remaining } from "../lib/time.ts";
import { Composer, type Draft } from "./composer.tsx";
import { BackIcon, SyncIcon } from "./icons.tsx";
import { MessageView } from "./message.tsx";

interface ThreadProps {
  handle: VibeHandle;
  thread: ThreadDetail | null;
  /** Why it could not be read, when it couldn't. */
  error: string | null;
  me: Whoami | null;
  actors: Actor[];
  can: ReadonlySet<Permission>;
  onChanged(): Promise<void>;
  onClose(): void;
  channelHref: string;
  onChannel(channel: string): void;
  /** The one channel the list beside the thread shows, when it shows exactly one. */
  listed: string | null;
}

/**
 * One thread, read as a log: its root, then its replies in order, each with
 * who wrote it and through whom. Above them, where the thread stands as a
 * task and which platforms it reaches. Below, the reply.
 */
export function ThreadView(props: ThreadProps) {
  const { handle, thread, me, can } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const rootId = thread?.message.id ?? null;

  // A thread that opens is where the keyboard goes, so reading starts there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new thread, not a new render, moves the focus
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [rootId]);

  if (props.error !== null) {
    return (
      <section className="thread" aria-label="Thread">
        <ThreadBar onClose={props.onClose} />
        <div className="empty">
          <p>{props.error}</p>
        </div>
      </section>
    );
  }
  if (thread === null) {
    return (
      <section className="thread" aria-label="Thread" aria-busy="true">
        <ThreadBar onClose={props.onClose} />
        <div className="message skeleton" aria-hidden="true" />
        <div className="message skeleton" aria-hidden="true" />
      </section>
    );
  }

  const { message, replies, task } = thread;
  const identity = me ? { principal: me.actor.principal, actor: me.actor.actor } : null;
  const targets = thread.sync?.targets ?? [];
  const failures = thread.sync?.failures ?? [];
  const reaches = targets
    .filter((target) => target.state !== "failed")
    .map((target) => target.target);
  const state = stateOf(message);

  async function reply(draft: Draft) {
    await handle.reply(message.id, draft.text, {
      attachments: draft.attachments,
      labels: Object.keys(draft.labels).length > 0 ? draft.labels : undefined,
      noSync: draft.noSync || undefined,
    });
    await props.onChanged();
  }

  return (
    <section className="thread" aria-labelledby="thread-title">
      <ThreadBar onClose={props.onClose}>
        <h2
          id="thread-title"
          ref={heading}
          tabIndex={-1}
          className="thread-title"
          data-listed={props.listed === message.channel || undefined}
        >
          <span className="thread-word">Thread</span>
          <a
            href={props.channelHref}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              props.onChannel(message.channel);
            }}
          >
            {message.channel}
          </a>
          {state && !task && (
            <span className="state-box" data-holder={state.holder}>
              {state.word.replaceAll("_", " ")}
            </span>
          )}
        </h2>
      </ThreadBar>

      <div className="thread-scroll">
        {task && (
          <TaskPanel
            handle={handle}
            task={task}
            me={me}
            canManage={can.has("manage")}
            onChanged={props.onChanged}
          />
        )}

        {targets.length > 0 && (
          <p className="synced">
            <SyncIcon />
            <span>
              Synced with{" "}
              {targets.map((target, index) => (
                <span key={target.target}>
                  {index > 0 && ", "}
                  {target.url ? (
                    <a href={target.url} target="_blank" rel="noreferrer noopener">
                      {target.target}
                    </a>
                  ) : (
                    target.target
                  )}
                  {target.state !== "synced" && ` (${target.state})`}
                </span>
              ))}
              . What is written here is read there too.
            </span>
          </p>
        )}

        <div className="log">
          <MessageView
            handle={handle}
            message={message}
            me={identity}
            can={can}
            failures={failures.filter((failure) => failure.message === message.id)}
            root
            onChanged={props.onChanged}
          />
          {replies.map((each) => (
            <MessageView
              key={each.id}
              handle={handle}
              message={each}
              me={identity}
              can={can}
              failures={failures.filter((failure) => failure.message === each.id)}
              root={false}
              onChanged={props.onChanged}
            />
          ))}
        </div>

        {thread.schedules.length > 0 && (
          <p className="scheduled">
            {thread.schedules.length === 1
              ? "A reply is"
              : `${thread.schedules.length} replies are`}{" "}
            scheduled here, the next from {who(thread.schedules[0]?.by ?? message.by)}.
          </p>
        )}
      </div>

      {can.has("post") ? (
        <div className="thread-reply">
          <Composer
            handle={handle}
            actors={props.actors}
            label="Reply"
            placeholder="Reply in this thread"
            submit="Reply"
            canLabel={can.has("label")}
            syncedWith={reaches}
            onSubmit={reply}
          />
        </div>
      ) : (
        <p className="thread-readonly">You can read this channel, and not post in it.</p>
      )}
    </section>
  );
}

function ThreadBar({ onClose, children }: { onClose(): void; children?: React.ReactNode }) {
  return (
    <header className="thread-bar">
      <button type="button" className="icon-button back-button" onClick={onClose}>
        <BackIcon />
        <span className="visually-hidden">Back to the threads</span>
      </button>
      {children}
    </header>
  );
}

const HELD: Record<string, string> = {
  awaiting_approval: "Waiting for approval",
  text_changed: "Its text was changed by someone else",
};

/**
 * Where a task stands, in words, and what its owner can do about it. Claiming
 * and finishing are the work of whoever holds the task, which is an agent
 * with the CLI. Unblocking, reopening and canceling are the owner's.
 */
function TaskPanel(props: {
  handle: VibeHandle;
  task: Task;
  me: Whoami | null;
  canManage: boolean;
  onChanged(): Promise<void>;
}) {
  const { handle, task, me } = props;
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [reason, setReason] = useState("");
  const [, tick] = useState(0);

  // A lease runs out by the clock, so the time left is counted here.
  const leased = task.state === "claimed" && task.leaseExpiresAt !== null;
  useEffect(() => {
    if (!leased) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [leased]);

  // A task is its owner's: a person's for the tasks their agents created too.
  const owns = me !== null && (task.owner.principal === me.actor.principal || props.canManage);
  const open = !["completed", "canceled"].includes(task.state);
  const holder = stateOf({ labels: { "vibe.task": task.state } })?.holder;
  const left = task.leaseExpiresAt === null ? null : remaining(task.leaseExpiresAt);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      setCanceling(false);
      setReason("");
      await props.onChanged();
    } catch (failure) {
      setError(
        failure instanceof VibeError
          ? [failure.message, failure.hint].filter(Boolean).join(" ")
          : "That didn't go through.",
      );
    } finally {
      setBusy(false);
    }
  }

  function cancel(event: FormEvent) {
    event.preventDefault();
    if (reason.trim() === "") {
      setError("Say why, for whoever reads the thread later.");
      return;
    }
    void act(() => handle.tasks.cancel(task.id, reason.trim()));
  }

  return (
    <section className="task" aria-label="Task">
      <div className="task-head">
        <span className="state-box" data-holder={holder}>
          {task.state}
        </span>
        <p className="task-line">
          Task owned by <strong>{who(task.owner)}</strong>
          {task.for !== null && (
            <>
              , kept for <strong>{task.for}</strong>
            </>
          )}
          {task.state === "claimed" && task.claimedBy && (
            <>
              . Held by <strong>{who(task.claimedBy)}</strong>
              {left === null ? ", whose lease has run out" : ` for ${left} more`}
            </>
          )}
          .
        </p>
      </div>
      {task.hold !== null && (
        <p className="task-note">
          <strong>{HELD[task.hold.kind] ?? "Held for a person"}:</strong> {task.hold.reason}
        </p>
      )}
      {task.needs.length > 0 && task.state === "waiting" && (
        <p className="task-note">
          Waits for {task.needs.length === 1 ? "another task" : `${task.needs.length} other tasks`}{" "}
          to complete.
        </p>
      )}
      {task.result !== null && (
        <p className="task-note">
          <strong>Result:</strong> {task.result}
        </p>
      )}
      {task.reason !== null && (
        <p className="task-note">
          <strong>Reason:</strong> {task.reason}
        </p>
      )}

      {owns && (
        <div className="task-actions">
          {task.state === "blocked" && (
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void act(() => handle.tasks.unblock(task.id))}
            >
              Unblock
            </button>
          )}
          {task.state === "failed" && (
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void act(() => handle.tasks.reopen(task.id))}
            >
              Reopen
            </button>
          )}
          {open && !canceling && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setCanceling(true)}
            >
              Cancel task
            </button>
          )}
        </div>
      )}
      {canceling && (
        <form className="inline-form" onSubmit={cancel}>
          <label htmlFor={`${id}-reason`}>Why is it canceled?</label>
          <input
            id={`${id}-reason`}
            type="text"
            value={reason}
            // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked to cancel
            autoFocus
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="inline-actions">
            <button type="button" className="button quiet" onClick={() => setCanceling(false)}>
              Keep the task
            </button>
            <button type="submit" className="button danger" disabled={busy}>
              Cancel task
            </button>
          </div>
        </form>
      )}
      {error !== null && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
