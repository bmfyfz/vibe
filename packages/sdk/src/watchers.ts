import type { WatcherDelivery } from "@vibe/contracts";

import { VibeError } from "./duration.ts";

/** How old a delivery may be before it is refused as a replay, in seconds. */
const TOLERANCE_SECONDS = 300;

export interface DeliveryProof {
  /** The watcher's secret, as `watchers create` showed it. */
  secret: string;
  /** The request's body exactly as it arrived, before any parsing. */
  body: string;
  /** The `Vibe-Signature` header. */
  signature: string | null | undefined;
  /** The `Vibe-Timestamp` header. */
  timestamp: string | null | undefined;
  /** How old a delivery may be, in seconds. Five minutes, when left out. */
  tolerance?: number | undefined;
  /** The time to judge its age by, in milliseconds. Now, when left out. */
  now?: number | undefined;
}

/**
 * Says whether a request to a watcher's URL is a delivery from Vibe: its
 * signature is the HMAC-SHA256 of the timestamp, a dot and the body, keyed
 * with the watcher's secret, and its timestamp is recent.
 *
 * Check before you act on a delivery, and with the body as it arrived: the
 * same JSON serialized again is a different body.
 */
export async function verifyDelivery(proof: DeliveryProof): Promise<boolean> {
  const { secret, body, signature, timestamp } = proof;
  const hex = /^v1=([0-9a-f]{64})$/.exec(signature ?? "")?.[1];
  if (!hex || !/^\d{1,12}$/.test(timestamp ?? "")) return false;

  const age = Math.abs((proof.now ?? Date.now()) / 1000 - Number(timestamp));
  if (age > (proof.tolerance ?? TOLERANCE_SECONDS)) return false;

  const encode = (text: string) => new TextEncoder().encode(text);
  const key = await crypto.subtle.importKey(
    "raw",
    encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const given = Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  // `verify` compares in constant time, so a wrong guess says nothing of how wrong.
  return crypto.subtle.verify("HMAC", key, given, encode(`${timestamp}.${body}`));
}

/**
 * Reads a delivery from the request Vibe made to a watcher's URL, having
 * checked that it is Vibe's.
 *
 * A delivery can arrive more than once: answer with a 2xx and Vibe moves on,
 * answer with anything else, or not within ten seconds, and Vibe sends it
 * again later, before anything newer. Its `id` is the same each time, so
 * that is what to deduplicate on. Write as the profile named by
 * `delivery.watcher.name`, and what you write won't be delivered back to you.
 *
 * @throws `invalid_signature` for a request that isn't a delivery from Vibe,
 *   or is one too old to trust.
 */
export async function receiveDelivery(
  request: Request,
  secret: string,
  options: { tolerance?: number | undefined } = {},
): Promise<WatcherDelivery> {
  const body = await request.text();
  const trusted = await verifyDelivery({
    secret,
    body,
    signature: request.headers.get("vibe-signature"),
    timestamp: request.headers.get("vibe-timestamp"),
    tolerance: options.tolerance,
  });
  if (!trusted) {
    throw new VibeError(
      "invalid_signature",
      "This request is not a delivery from Vibe, or is too old to trust.",
      0,
      "Check that the secret is the one `vibe watchers create` printed for this watcher.",
    );
  }
  return JSON.parse(body) as WatcherDelivery;
}
