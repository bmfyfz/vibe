// `bun start`: a whole Vibe on this machine, from a fresh checkout, in one
// command. It builds the web app when it hasn't been built, then runs
// `vibe serve`, which prints the URL and a token that owns the new Vibe.
// Whatever follows `bun start` goes to `vibe serve`: `bun start --port 8000`.
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const run = (args: string[]) =>
  Bun.spawn(["bun", ...args], { cwd: root, stdio: ["inherit", "inherit", "inherit"] });

if (!existsSync(join(root, "node_modules"))) {
  console.error("Installing dependencies…");
  if ((await run(["install"]).exited) !== 0) process.exit(1);
}

if (!existsSync(join(root, "apps/web/dist/index.html"))) {
  // On stderr, so stdout stays what `vibe serve` prints.
  console.error("Building the web app, once…");
  const build = Bun.spawn(["bun", "run", "--filter", "@vibe/web", "build"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if ((await build.exited) !== 0) {
    console.error("The web app did not build. Serving the API alone.");
  }
}

const given = process.argv.slice(2);
const serve = run([join(root, "apps/cli/src/main.ts"), "serve", ...given, ...forwarded(given)]);
// Ctrl-C reaches `vibe serve` too, which stops what it started. Wait for it.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => serve.kill("SIGTERM"));
process.exit(await serve.exited);

/**
 * In a GitHub Codespace the port is reached through GitHub's proxy, over
 * https, at an address of the Codespace's own. A browser signs in only when
 * Vibe knows that address, so it is worked out here unless one was given.
 */
function forwarded(args: string[]): string[] {
  const { CODESPACE_NAME: name, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain } = process.env;
  if (!name || !domain || args.includes("--public-url") || process.env["VIBE_PUBLIC_URL"])
    return [];
  const port = args[args.indexOf("--port") + 1];
  const listens = args.includes("--port") && port ? port : (process.env["VIBE_PORT"] ?? "7473");
  return ["--public-url", `https://${name}-${listens}.${domain}`];
}
