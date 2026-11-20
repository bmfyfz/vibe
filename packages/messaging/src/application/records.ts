import type { EventRecord } from "@vibe/kernel";

import type { Thread, ThreadEvent } from "../domain/thread.ts";

/** Turns what happened in a thread into rows for the vibe's event log. */
export function toRecords(thread: Thread, events: readonly ThreadEvent[]): EventRecord[] {
  const { vibeId, channel } = thread.snapshot;
  return events.map((event) => ({
    vibeId,
    // A noted change goes by the name its own context gave it.
    type: event.type === "thread.noted" ? event.as : event.type,
    channel,
    threadId: event.threadId,
    threadVersion: event.threadVersion,
    messageId: event.messageId,
    actorId: event.actorId,
    payload: payloadOf(event),
    facets: event.facets,
    createdAt: event.at,
  }));
}

/** The details of a change that a follower can't read off the message itself. */
function payloadOf(event: ThreadEvent): Record<string, unknown> {
  switch (event.type) {
    case "message.posted":
      return {};
    case "message.edited":
    case "message.deleted":
      return { revision: event.revision };
    case "reaction.added":
    case "reaction.removed":
      return { emoji: event.emoji };
    case "labels.changed":
      return { set: event.set, unset: event.unset };
    case "thread.noted":
      return { ...event.payload };
  }
}
