import {
  type Actor,
  type Channel,
  type ThreadDetail,
  type ThreadSummary,
  VibeError,
  type VibeEvent,
  type VibeHandle,
  type Whoami,
} from "@vibe/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { matchesPattern } from "../lib/channel-tree.ts";

/** Which of a channel's threads are listed. */
export interface Filters {
  /** Only threads that mention you. */
  mentions: boolean;
  /** Only tasks. */
  tasks: boolean;
}

/** How the page stands with the vibe's event log. */
export type Liveness = "connecting" | "live" | "retrying";

export interface VibeData {
  me: Whoami | null;
  channels: Channel[];
  actors: Actor[];
  /** The listed threads, latest activity first. `null` while the first read is out. */
  threads: ThreadSummary[] | null;
  /** The open thread. `null` while it is being read, or when none is open. */
  thread: ThreadDetail | null;
  /** Why the open thread could not be read, when it couldn't. */
  threadError: string | null;
  /** The threads that changed since you last looked at them, by their root. */
  unseen: ReadonlySet<string>;
  /** The channels that hold one. */
  unseenChannels: ReadonlySet<string>;
  liveness: Liveness;
  /** Reads the list and the open thread again, after a change the page made itself. */
  refresh(): Promise<void>;
}

// A burst of events, such as a plan of tasks, is one reason to read again, not fifteen.
const SETTLE_MS = 120;
const LIST_LIMIT = 60;

/**
 * What the page knows of one vibe, kept up to date from its event log. An
 * event says that something changed and where. What it changed is read again
 * through the same calls that drew it, so the page never shows a state the
 * API wouldn't.
 */
export function useVibe(
  handle: VibeHandle,
  channel: string | null,
  threadId: string | null,
  filters: Filters,
  /** Called when the Vibe no longer knows the browser: the session ended. */
  onSignedOut: () => void,
): VibeData {
  const [me, setMe] = useState<Whoami | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [actors, setActors] = useState<Actor[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [unseen, setUnseen] = useState<Map<string, string>>(new Map());
  const [liveness, setLiveness] = useState<Liveness>("connecting");

  // What the event loop needs to know of the page as it is now, without being restarted by it.
  const now = useRef({ channel, threadId, filters, me, openRoot: null as string | null });
  now.current = { channel, threadId, filters, me, openRoot: thread?.message.id ?? null };
  const asked = useRef({ list: 0, thread: 0 });
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;
  /** A read that failed says nothing here, unless it failed because the session is over. */
  const failed = useCallback((error: unknown) => {
    if (error instanceof VibeError && error.status === 401) signedOut.current();
  }, []);

  // Where the vibe's log stood at the page's first reading of it. The log is
  // followed from there, and not from wherever it has got to by the time the
  // following starts: what is written in between would be in neither.
  // biome-ignore lint/correctness/useExhaustiveDependencies: another vibe has another log
  const began = useMemo(() => Promise.withResolvers<string | undefined>(), [handle]);

  const readList = useCallback(async () => {
    const turn = ++asked.current.list;
    const { channel: pattern, filters: wanted } = now.current;
    const page = await handle.threads({
      channel: pattern ?? undefined,
      mentions: wanted.mentions ? "me" : undefined,
      label: wanted.tasks ? "vibe.task" : undefined,
      limit: LIST_LIMIT,
    });
    began.resolve(page.cursor);
    // A read that was overtaken by a later one says what is no longer asked.
    if (turn === asked.current.list) setThreads(page.threads);
  }, [handle, began]);

  const readThread = useCallback(async () => {
    const turn = ++asked.current.thread;
    const id = now.current.threadId;
    if (id === null) {
      setThread(null);
      setThreadError(null);
      return;
    }
    try {
      const detail = await handle.thread(id);
      if (turn !== asked.current.thread) return;
      setThread(detail);
      setThreadError(null);
    } catch (error) {
      failed(error);
      if (turn !== asked.current.thread) return;
      setThread(null);
      setThreadError(error instanceof Error ? error.message : String(error));
    }
  }, [handle, failed]);

  const readPeople = useCallback(async () => {
    const [who, list, known] = await Promise.all([
      handle.whoami(),
      handle.channels(),
      handle.actors(),
    ]);
    setMe(who);
    setChannels(list);
    setActors(known);
  }, [handle]);

  // The vibe changed: everything is read again.
  useEffect(() => {
    setMe(null);
    setChannels([]);
    setUnseen(new Map());
    readPeople().catch(failed);
  }, [readPeople, failed]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new place or filter is the reason to read
  useEffect(() => {
    setThreads(null);
    readList().catch((error: unknown) => {
      // Nothing was read, so there is nowhere earlier to follow from than now.
      began.resolve(undefined);
      failed(error);
      setThreads([]);
    });
  }, [readList, failed, channel, filters.mentions, filters.tasks]);

  useEffect(() => {
    setThread(null);
    setThreadError(null);
    readThread().catch(() => {});
    // Opening a thread is looking at it.
    if (threadId !== null) {
      setUnseen((before) => {
        const root = [...before.keys()].find((id) => id === threadId);
        if (root === undefined) return before;
        const after = new Map(before);
        after.delete(root);
        return after;
      });
    }
  }, [readThread, threadId]);

  // The open thread's root is what the marks are kept by. Once it is known, its mark goes.
  const openRoot = thread?.message.id ?? null;
  useEffect(() => {
    if (openRoot === null) return;
    setUnseen((before) => {
      if (!before.has(openRoot)) return before;
      const after = new Map(before);
      after.delete(openRoot);
      return after;
    });
  }, [openRoot]);

  // Follows the vibe's log for as long as the page shows this vibe.
  useEffect(() => {
    const stopped = new AbortController();
    let listTimer: ReturnType<typeof setTimeout> | undefined;
    let threadTimer: ReturnType<typeof setTimeout> | undefined;
    let peopleTimer: ReturnType<typeof setTimeout> | undefined;
    const soon = (timer: ReturnType<typeof setTimeout> | undefined, read: () => Promise<void>) => {
      clearTimeout(timer);
      return setTimeout(() => void read().catch(failed), SETTLE_MS);
    };

    const heard = (event: VibeEvent) => {
      const { message } = event;
      const state = now.current;
      if (!message) {
        // A channel was made, or something else that concerns no message.
        peopleTimer = soon(peopleTimer, readPeople);
        return;
      }
      const root = message.re ?? message.id;
      if (matchesPattern(state.channel, message.channel)) listTimer = soon(listTimer, readList);
      // The open thread is known by any message of it, and once read, by its root.
      const open = state.threadId !== null && (state.threadId === root || state.openRoot === root);
      if (open) threadTimer = soon(threadTimer, readThread);
      if (event.type === "message.posted" && message.re === null) {
        // A first post may have made its channel.
        peopleTimer = soon(peopleTimer, readPeople);
      }
      // What you did yourself is not news to you, and neither is the thread you are reading.
      // Your agents write under your name, and what they do is news to you all the same.
      const mine = state.me !== null && event.actor.actor === state.me.actor.actor;
      const watching = open && document.visibilityState === "visible";
      if (!mine && !watching) {
        setUnseen((before) => new Map(before).set(root, message.channel));
      }
    };

    void (async () => {
      try {
        const after = await began.promise;
        if (stopped.signal.aborted) return;
        for await (const event of handle.events(
          { after },
          { signal: stopped.signal, onState: setLiveness },
        )) {
          heard(event);
        }
      } catch (error) {
        // Refused. When that is the session ending, the page says so and asks to sign in.
        setLiveness("retrying");
        failed(error);
      }
    })();
    return () => {
      stopped.abort();
      clearTimeout(listTimer);
      clearTimeout(threadTimer);
      clearTimeout(peopleTimer);
    };
  }, [handle, began, readList, readThread, readPeople, failed]);

  const refresh = useCallback(async () => {
    await Promise.all([readList(), readThread()]);
  }, [readList, readThread]);

  const unseenThreads = useMemo(() => new Set(unseen.keys()), [unseen]);
  const unseenChannels = useMemo(() => new Set(unseen.values()), [unseen]);
  return {
    me,
    channels,
    actors,
    threads,
    thread,
    threadError,
    unseen: unseenThreads,
    unseenChannels,
    liveness,
    refresh,
  };
}
