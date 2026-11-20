import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WEB_HEADERS, webSite } from "./web.ts";

describe("the web app's files", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Vibe</title>");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(dir, "..", "outside.txt"), "not the app's");
  const site = webSite(dir);
  const get = (path: string, method = "GET") =>
    site?.(new Request(`http://vibe.test${path}`, { method })) ?? null;

  test("a path that names a file gets it, and any other path gets the app", async () => {
    expect(site).not.toBeNull();
    const script = get("/assets/index-abc123.js");
    expect(script?.headers.get("content-type")).toStartWith("text/javascript");
    expect(script?.headers.get("cache-control")).toContain("immutable");
    expect(await script?.text()).toBe("console.log(1)");

    for (const path of ["/", "/v/general/c/www/production", "/index.html"]) {
      const page = get(path);
      expect(page?.status).toBe(200);
      expect(page?.headers.get("content-type")).toStartWith("text/html");
      expect(page?.headers.get("cache-control")).toBe("no-cache");
      expect(await page?.text()).toContain("<title>Vibe</title>");
    }
    // A file the app doesn't have is missing, not the app under another name.
    expect(get("/assets/gone.js")?.status).toBe(404);
    expect(get("/", "POST")).toBeNull();
  });

  test("nothing outside the directory is served, however the path is spelled", async () => {
    for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/assets/../../outside.txt"]) {
      const answer = get(path);
      expect(await answer?.text()).not.toContain("not the app's");
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(dir, "..", "outside.txt"), { force: true });
  });

  test("every answer carries the policy, and the Worker's copy of it says the same", () => {
    const page = get("/");
    for (const [name, value] of Object.entries(WEB_HEADERS)) {
      expect(page?.headers.get(name)).toBe(value);
    }
    expect(WEB_HEADERS["content-security-policy"]).toContain("script-src 'self'");
    expect(WEB_HEADERS["content-security-policy"]).not.toContain("unsafe");

    // The Worker serves the same files with the headers in `_headers`.
    const file = readFileSync(join(import.meta.dir, "../../../apps/web/public/_headers"), "utf8");
    const declared = Object.fromEntries(
      file
        .split("\n")
        .filter((line) => line.startsWith("  "))
        .map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        }),
    );
    expect(declared).toEqual({ ...WEB_HEADERS });
  });

  test("a directory with no built app in it serves nothing", () => {
    expect(webSite(join(tmpdir(), "vibe-no-such-web-app"))).toBeNull();
  });
});
