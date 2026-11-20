import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A browser's globals, for the tests of a page. A file that draws registers
// them before it loads the testing library, which looks for `document` when
// it is loaded. Bun runs every test file in one process, so the file that
// registers them also takes them away when it is done.
export const ORIGIN = "http://vibe.test";

// What a page and a server both use, and Bun already has: its own are kept,
// so the Vibe that runs in the test's process is served by the real ones.
const KEPT = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "Blob",
  "File",
  "FormData",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
  "WebSocket",
  "crypto",
  // What a test or the page says is said where the test runner prints it.
  "console",
] as const;

export function registerDom(): void {
  if (GlobalRegistrator.isRegistered) return;
  const scope = globalThis as unknown as Record<string, unknown>;
  const own = KEPT.map((name) => [name, scope[name]] as const);
  GlobalRegistrator.register({ url: `${ORIGIN}/` });
  for (const [name, value] of own) scope[name] = value;
}

export async function unregisterDom(): Promise<void> {
  if (!GlobalRegistrator.isRegistered) return;
  const scope = globalThis as unknown as Record<string, unknown>;
  const own = KEPT.map((name) => [name, scope[name]] as const);
  await GlobalRegistrator.unregister();
  for (const [name, value] of own) scope[name] = value;
}
