import { rateLimited } from "@vibe/kernel";

/**
 * How often something may be tried from one place in one stretch of time.
 * What a budget bounds is guessing: a secret that could be tried without end
 * is only as good as it is long.
 */
export interface Budget {
  /** What is counted. Every key counted against the budget starts with it. */
  readonly name: string;
  /** How many attempts a stretch allows. */
  readonly most: number;
  /** How long a stretch is, in milliseconds. */
  readonly windowMs: number;
  /** What is said to whoever has used it up. */
  readonly refusal: string;
}

const MINUTE = 60_000;

/**
 * Credentials that were refused: a token or a session nobody has, wherever it
 * was shown. While an address is over, nothing it shows is looked at.
 */
export const REFUSED_CREDENTIALS: Budget = {
  name: "credential",
  most: 30,
  windowMs: MINUTE,
  refusal: "Too many credentials from your address were refused.",
};

/**
 * Tries at the operator's secret. It is counted before it is compared, since
 * it is the one secret here that a person chose, and may be short.
 */
export const OPERATOR_SECRET: Budget = {
  name: "operator",
  most: 10,
  windowMs: 10 * MINUTE,
  refusal: "Too many tries at the operator's secret came from your address.",
};

/** Webhooks that were refused: sent to an entry with a signature that isn't its platform's. */
export const REFUSED_WEBHOOKS: Budget = {
  name: "webhook",
  most: 30,
  windowMs: MINUTE,
  refusal: "Too many webhooks from your address were refused.",
};

/** Sign-ins started through GitHub. Each one is a request Vibe makes of GitHub, on the app's own allowance. */
export const SIGN_INS_STARTED: Budget = {
  name: "sign-in",
  most: 10,
  windowMs: 10 * MINUTE,
  refusal: "Too many sign-ins were started from your address.",
};

/** Asks whether a sign-in was approved. A device asks every five seconds, and each ask goes on to GitHub. */
export const SIGN_IN_ASKS: Budget = {
  name: "sign-in-ask",
  most: 60,
  windowMs: MINUTE,
  refusal: "A sign-in was asked after too often from your address.",
};

/** A stretch of time attempts are counted in. */
export interface Window {
  readonly start: number;
  readonly end: number;
}

/**
 * The stretch that holds `now`. Stretches lie end to end from the epoch, so
 * every server agrees on where one ends without having to store it, and a
 * refusal can say how long is left of it.
 */
export function windowAt(budget: Budget, now: number): Window {
  const start = Math.floor(now / budget.windowMs) * budget.windowMs;
  return { start, end: start + budget.windowMs };
}

/** The key a budget's attempts are counted under for one caller: `credential:203.0.113.7`. */
export function attemptKey(budget: Budget, who: string): string {
  return `${budget.name}:${who}`;
}

/** Refuses a caller that has used a budget up, and says when the stretch ends. */
export function tooManyAttempts(budget: Budget, now: number) {
  const left = Math.max(1, windowAt(budget, now).end - now);
  return rateLimited(
    "rate_limited",
    budget.refusal,
    left,
    `Try again in ${Math.ceil(left / 1000)} seconds.`,
  );
}

const MAX_ADDRESS_LENGTH = 64;

/**
 * Who a network address is counted as. An IPv4 address is itself. An IPv6
 * address is its first 64 bits, since whoever has one address of a network
 * has all of them, and would otherwise have a budget for each. An IPv4
 * address written as IPv6 is the IPv4 address.
 *
 * Anything that isn't an address is counted as what it says, cut short: this
 * is what bounds a caller, so it never throws and never answers "no one".
 */
export function addressKey(address: string): string {
  let text = address.trim().toLowerCase();
  // `[2001:db8::1]:443`, and the zone of a link-local address, `fe80::1%en0`.
  if (text.startsWith("[")) text = text.slice(1).split("]")[0] ?? "";
  text = text.split("%")[0] ?? "";
  // `203.0.113.7:51234`, as some proxies write it: the port is the
  // connection's, and would make every connection a caller of its own.
  text = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text)?.[1] ?? text;
  const groups = text.includes(":") ? groupsOf(text) : null;
  if (groups === null) return text.slice(0, MAX_ADDRESS_LENGTH);

  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return `${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`;
  }
  return `${[a, b, c, d].map((group) => group.toString(16)).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address, or `null` for text that isn't one. */
function groupsOf(text: string): number[] | null {
  let rest = text;
  const tail: number[] = [];
  // The last 32 bits may be written as an IPv4 address: `::ffff:192.0.2.1`.
  if (rest.includes(".")) {
    const cut = rest.lastIndexOf(":");
    const bytes = rest.slice(cut + 1).split(".");
    if (bytes.length !== 4 || !bytes.every((byte) => /^\d{1,3}$/.test(byte))) return null;
    const [w = 0, x = 0, y = 0, z = 0] = bytes.map(Number);
    if (w > 255 || x > 255 || y > 255 || z > 255) return null;
    tail.push((w << 8) | x, (y << 8) | z);
    rest = rest.slice(0, cut + 1);
    if (!rest.endsWith("::")) rest = rest.slice(0, -1);
  }

  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (half === "") return [];
    const parts = half.split(":");
    if (!parts.every((part) => /^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const head = parse(halves[0] ?? "");
  const after = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || after === null) return null;

  const given = head.length + after.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  return [...head, ...new Array<number>(8 - given).fill(0), ...after, ...tail];
}
