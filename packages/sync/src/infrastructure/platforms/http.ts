import type { Send } from "../../application/platform.ts";
import { PlatformError } from "../../domain/delivery.ts";

// How long a platform has to answer.
const TIMEOUT_MS = 10_000;

/**
 * One request to a platform's API. A redirect is not followed: the request
 * carries the entry's token, and goes where the entry said and nowhere else.
 *
 * @throws `PlatformError` when the platform can't be reached in time.
 */
export async function request(
  send: Send,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  try {
    return await send(url, {
      ...init,
      headers: { "user-agent": "vibe-sync/1", ...init.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PlatformError(`${new URL(url).host} could not be reached: ${message}`);
  }
}

/** How long a platform asked to be left alone, from its `Retry-After`, in milliseconds. */
export function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : null;
}

/** A response's body as JSON, or `null` when it isn't that. */
export async function jsonOf(response: Response): Promise<Record<string, unknown> | null> {
  const body: unknown = await response.json().catch(() => null);
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

/** Reads a field that should be text. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Reads a field that should be an object. An empty one, when it isn't. */
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads a field that should be a list of objects. */
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

/** A webhook's body as JSON. An empty object for a body that isn't one: its signature was checked, its sense wasn't. */
export function parseBody(body: string): Record<string, unknown> {
  try {
    return record(JSON.parse(body));
  } catch {
    return {};
  }
}
