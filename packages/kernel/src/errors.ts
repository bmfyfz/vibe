/** How a failure should be understood by whoever called. Adapters map this to a transport status. */
export type ErrorKind =
  | "invalid"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "length_required"
  | "too_large"
  /** Asked too often. `retryAfterMs` on the error says how long to leave it. */
  | "rate_limited"
  /** Something Vibe depends on, such as another server, failed. Trying again later may work. */
  | "unavailable";

/**
 * A failure the caller can act on. `code` is the stable, machine-readable reason
 * (`newer_message`, `forbidden`, …); `hint` says what fixes it, when something does.
 */
export class DomainError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
    readonly hint?: string,
    /** How long until asking again can work, in milliseconds, when the failure passes by itself. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

const of =
  (kind: ErrorKind) =>
  (code: string, message: string, hint?: string): DomainError =>
    new DomainError(kind, code, message, hint);

export const invalid = of("invalid");
export const unauthorized = of("unauthorized");
export const forbidden = of("forbidden");
export const notFound = of("not_found");
export const conflict = of("conflict");
export const lengthRequired = of("length_required");
export const tooLarge = of("too_large");
export const unavailable = of("unavailable");

/** Refuses something asked too often, and says how long until it can be asked again. */
export const rateLimited = (
  code: string,
  message: string,
  retryAfterMs: number,
  hint?: string,
): DomainError => new DomainError("rate_limited", code, message, hint, retryAfterMs);
