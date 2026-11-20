/** Where in a vibe the page is: which channels are listed, and which thread is open. */
export interface Place {
  vibe: string;
  /** A channel, a subtree such as `www/`, or `null` for every channel. */
  channel: string | null;
  /** The thread that is open, by any message of it. */
  thread: string | null;
}

export const DEFAULT_VIBE = "general";

/**
 * Reads a place from an address: `/v/<vibe>/c/<channel path>?t=<message>`.
 * A channel's path holds slashes, so it is what is left of the path.
 */
export function parsePlace(pathname: string, search: string): Place {
  const match = /^\/v\/([^/]+)(?:\/c\/(.+))?\/?$/.exec(pathname);
  const thread = new URLSearchParams(search).get("t");
  return {
    vibe: match?.[1] ? decodeURIComponent(match[1]) : DEFAULT_VIBE,
    channel: match?.[2] ? decodeURI(match[2]) : null,
    thread: thread || null,
  };
}

export function formatPlace(place: Place): string {
  const channel = place.channel === null ? "" : `/c/${encodeURI(place.channel)}`;
  const thread = place.thread === null ? "" : `?t=${encodeURIComponent(place.thread)}`;
  return `/v/${encodeURIComponent(place.vibe)}${channel}${thread}`;
}
