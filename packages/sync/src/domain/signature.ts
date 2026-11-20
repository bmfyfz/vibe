const encode = (text: string) => new TextEncoder().encode(text);

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

/** HMAC-SHA256 of a text, keyed with a secret, as lowercase hex. */
export async function hmacHex(secret: string, text: string): Promise<string> {
  const signed = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encode(text));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether `hex` is the HMAC-SHA256 of a text under a secret. The comparison is
 * the runtime's own, which takes the same time wherever the two differ, so a
 * forger learns nothing from how long a refusal took.
 */
export async function verifyHmacHex(secret: string, text: string, hex: string): Promise<boolean> {
  const given = fromHex(hex);
  if (given === null) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), given, encode(text));
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2}){32}$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
