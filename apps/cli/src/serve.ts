import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";

import { serveVibe } from "@vibe/server/bun";

import { integer, UsageError } from "./shared.ts";

export interface ServeFlags {
  port?: string | undefined;
  host?: string | undefined;
  dir?: string | undefined;
  web?: string | undefined;
  "address-header"?: string | undefined;
  "public-url"?: string | undefined;
  json?: boolean | undefined;
}

/** What `vibe serve` remembers between runs, beside the database. */
interface Kept {
  /** The operator's secret for `/v1/admin`. */
  adminSecret?: string | undefined;
  /** The owner's token, so the same one is printed at every start. */
  token?: string | undefined;
  handle?: string | undefined;
}

/** "VIBE" on a phone's keypad. Far from the ports dev servers take. */
const DEFAULT_PORT = 7473;

/**
 * `vibe serve`: a whole Vibe on this machine, for working offline and for
 * testing without writing to a team's. It keeps everything in `.vibe/` at the
 * root of the Git checkout, prints the `VIBE_URL` that reaches it and a token
 * that owns it, and runs until it is stopped.
 */
export async function serve(flags: ServeFlags): Promise<number> {
  const dir = resolve(flags.dir ?? join(checkoutRoot(), ".vibe"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Whatever repository this is in, the directory keeps itself out of it.
  const ignore = Bun.file(join(dir, ".gitignore"));
  if (!(await ignore.exists())) await Bun.write(ignore, "*\n");

  const kept = await load(dir);
  // An empty variable is one that was not set, as a compose file passes it.
  const adminSecret = process.env["VIBE_ADMIN_SECRET"] || kept.adminSecret || secret();
  const port =
    flags.port === undefined
      ? Number(process.env["VIBE_PORT"] ?? DEFAULT_PORT)
      : flags.port === "0"
        ? 0
        : integer(flags.port, "--port");

  const publicUrl = (flags["public-url"] ?? process.env["VIBE_PUBLIC_URL"])?.trim() || undefined;
  let served: ReturnType<typeof serveVibe>;
  try {
    const clientId = process.env["VIBE_GITHUB_CLIENT_ID"];
    served = serveVibe({
      dir,
      port,
      hostname: flags.host,
      adminSecret,
      github: clientId
        ? { clientId, allowSignup: process.env["VIBE_GITHUB_SIGNUP"] === "true" }
        : undefined,
      web: webDirectory(flags.web),
      addressHeader:
        (flags["address-header"] ?? process.env["VIBE_ADDRESS_HEADER"])?.trim() || undefined,
      publicUrl,
    });
  } catch (error) {
    if ((error as { code?: string }).code === "EADDRINUSE") {
      throw new UsageError(
        `Port ${port} is taken. Is a Vibe already serving here? Pass --port to use another.`,
      );
    }
    // A header or an address that can't be one: said once, as how the command was called.
    if (error instanceof TypeError) throw new UsageError(error.message);
    throw error;
  }

  // Where people are told to go: the address they reach it at, when one was given.
  const url =
    publicUrl?.replace(/\/+$/, "") ??
    served.url.replace(/\/\/(0\.0\.0\.0|\[::\]):/, "//localhost:");
  // Where it listens, which is where a proxy sends what it receives.
  const listening = served.url.replace(/\/\/(0\.0\.0\.0|\[::\]):/, "//localhost:");
  // Asked of itself, at the address it listens on: one that takes IPv6 alone
  // has nothing at 127.0.0.1.
  const itself = served.url.replace("//0.0.0.0:", "//127.0.0.1:").replace("//[::]:", "//[::1]:");
  const owner = await ownerOf(itself, adminSecret, kept);
  await save(dir, { adminSecret, ...owner });

  if (flags.json) {
    console.log(
      JSON.stringify({
        url,
        listening,
        token: owner.token,
        handle: owner.handle,
        adminSecret,
        dir,
        web: served.web,
      }),
    );
  } else {
    console.log(
      [
        url === listening
          ? `Vibe is serving ${dir} at ${url}`
          : `Vibe is serving ${dir} at ${url}, and listens on ${listening}`,
        served.web
          ? `Open ${url} in a browser, and sign in with the token below.`
          : "The web app isn't built, so only the API is served. To have it: bun web:build",
        "",
        `  export VIBE_URL=${url}`,
        `  export VIBE_TOKEN=${owner.token}`,
        "",
        `The token is ${owner.handle}'s, who owns this Vibe.${url === listening ? " Nothing you post here leaves this machine." : ""}`,
        `The operator's secret, for \`vibe admin\`: ${adminSecret}`,
        "Press Ctrl-C to stop.",
      ].join("\n"),
    );
  }

  const signal = await new Promise<"SIGINT" | "SIGTERM">((stopWith) => {
    process.once("SIGINT", () => stopWith("SIGINT"));
    process.once("SIGTERM", () => stopWith("SIGTERM"));
  });
  await served.stop();
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Where the built web app is: where `--web` or `VIBE_WEB_DIR` says, or beside
 * a compiled `vibe`, in `web/`, or in this checkout, where `bun web:build`
 * leaves it. `undefined` when none of them holds one.
 */
function webDirectory(flag: string | undefined): string | undefined {
  const named = flag ?? process.env["VIBE_WEB_DIR"];
  const candidates =
    named !== undefined
      ? [resolve(named)]
      : [join(dirname(process.execPath), "web"), join(import.meta.dir, "../../web/dist")];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html")));
}

/** The root of the Git checkout this runs in, or the current directory outside of one. */
function checkoutRoot(): string {
  try {
    const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stderr: "ignore" });
    const root = git.stdout.toString().trim();
    if (git.exitCode === 0 && root !== "") return root;
  } catch {
    // No git on this machine.
  }
  return process.cwd();
}

/**
 * The person this Vibe is for, and a token of theirs that works. On a first
 * run they are added as its owner. On a later one the token that was kept is
 * checked, and replaced when the database no longer knows it.
 */
async function ownerOf(
  url: string,
  adminSecret: string,
  kept: Kept,
): Promise<{ token: string; handle: string }> {
  if (kept.token !== undefined && kept.handle !== undefined) {
    const known = await fetch(`${url}/v1/whoami`, {
      headers: { authorization: `Bearer ${kept.token}` },
    });
    // Only "nobody has this token" means it was lost. Any other answer says
    // nothing about the token, and must not mint another beside it.
    if (known.status !== 401) {
      if (!known.ok) console.error(`The kept token could not be checked: ${known.status}.`);
      return { token: kept.token, handle: kept.handle };
    }
  }

  const handle = kept.handle ?? localHandle();
  const admin = (path: string, body: unknown) =>
    fetch(`${url}/v1/admin${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminSecret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let response = await admin("/users", { handle, role: "owner" });
  // The database knows them and the token was lost: they get another.
  if (response.status === 409) response = await admin(`/users/${handle}/tokens`, {});
  const body = (await response.json().catch(() => null)) as { token?: string } | null;
  if (!response.ok || !body?.token) {
    throw new Error(`Could not add ${handle} to the new Vibe: it answered ${response.status}.`);
  }
  return { token: body.token, handle };
}

/**
 * Who owns a new Vibe: whoever `VIBE_OWNER` names, or this machine's user,
 * spelled as a handle. `admin` when the name can't be one.
 */
function localHandle(): string {
  let name = process.env["VIBE_OWNER"]?.trim() ?? "";
  try {
    if (name === "") name = userInfo().username;
  } catch {
    // No user to ask about, as in some containers.
  }
  const handle = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
    .replace(/-+$/, "");
  return handle === "" ? "admin" : handle;
}

function secret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const kept = (dir: string) => join(dir, "serve.json");

async function load(dir: string): Promise<Kept> {
  try {
    const parsed: unknown = JSON.parse(await readFile(kept(dir), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Kept) : {};
  } catch {
    return {};
  }
}

/** Written so only its owner can read it: it holds a token and the operator's secret. */
async function save(dir: string, state: Kept): Promise<void> {
  await writeFile(kept(dir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(kept(dir), 0o600);
}
