import type { Vault } from "../application/ports.ts";

const encode = (text: string) => new TextEncoder().encode(text);

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );

// Says what the key is for, so the same secret gives another key for anything else.
const PURPOSE = "vibe/sync/credentials/v1";

/**
 * Seals with AES-256-GCM, under a key derived from a secret of the deployment
 * with HKDF. What is sealed says what it belongs to, and opens only for that:
 * one entry's credentials, copied into another's row, don't open there.
 *
 * It protects against whoever can read the database and nothing else. Whoever
 * also holds the deployment's secret can open everything.
 */
export class AesVault implements Vault {
  private key: Promise<CryptoKey> | null = null;

  /** @param secret A secret of the deployment. Changing it leaves everything sealed before unreadable. */
  constructor(private readonly secret: string) {}

  async seal(plain: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encode(context) },
      await this.derived(),
      encode(plain),
    );
    return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`;
  }

  async open(sealed: string, context: string): Promise<string> {
    const [version, iv, body] = sealed.split(".");
    if (version !== "v1" || !iv || !body) throw new Error("This is not something a vault sealed.");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: encode(context) },
      await this.derived(),
      fromBase64Url(body),
    );
    return new TextDecoder().decode(plain);
  }

  private derived(): Promise<CryptoKey> {
    this.key ??= (async () => {
      const material = await crypto.subtle.importKey("raw", encode(this.secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encode(PURPOSE) },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    return this.key;
  }
}
