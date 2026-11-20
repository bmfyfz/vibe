// `bun run cli:install`: puts a `vibe` command on your PATH. It compiles the
// CLI to one file, with the web app beside it, and links it from the
// directory Bun keeps its own commands in (~/.bun/bin), or from the
// directory VIBE_BIN_DIR names.
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bin =
  process.env["VIBE_BIN_DIR"] || join(process.env["BUN_INSTALL"] || join(homedir(), ".bun"), "bin");
const built = join(root, "apps/cli/dist/vibe");
const link = join(bin, "vibe");

const build = Bun.spawn(["bun", "run", "--filter", "@vibe/cli", "build"], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});
if ((await build.exited) !== 0 || !existsSync(built)) {
  console.error("The CLI did not build.");
  process.exit(1);
}

mkdirSync(bin, { recursive: true });
// Replace a link from an earlier install. Anything else there is not ours to remove.
const there = lstatSync(link, { throwIfNoEntry: false });
if (there?.isSymbolicLink()) rmSync(link);
else if (there) {
  console.error(
    `${link} exists and is not a link this script made. Remove it, or set VIBE_BIN_DIR.`,
  );
  process.exit(1);
}
symlinkSync(built, link);

const onPath = (process.env["PATH"] ?? "").split(":").includes(bin);
console.log(`Installed ${link} -> ${built}`);
console.log(onPath ? "Try it: vibe help" : `Add ${bin} to your PATH, then: vibe help`);
