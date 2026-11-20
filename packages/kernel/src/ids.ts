// Crockford base32, lowercase.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function randomChars(count: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  let out = "";
  // 256 is a multiple of 32, so `% 32` stays uniform.
  for (const byte of bytes) out += ALPHABET.charAt(byte % 32);
  return out;
}

/**
 * A prefixed ULID such as `msg_01jd…`: 48 bits of time, then 80 random bits.
 * IDs are opaque. Nothing may sort by one or compute with one.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  let time = "";
  let rest = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  return `${prefix}_${time}${randomChars(16)}`;
}

/** A secret with 200 bits of entropy, for credentials. */
export function newSecret(prefix: string): string {
  return `${prefix}_${randomChars(40)}`;
}
