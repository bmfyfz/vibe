// `bun run labels`: makes the repository's issue labels match
// .github/labels.json, through the `gh` CLI. A label that exists is updated,
// one that doesn't is created, and none is deleted.
//
//   bun run labels                      the repository this checkout pushes to
//   bun run labels --repo owner/name    another one
//   bun run labels --dry-run            print what would run, and run nothing
import { join } from "node:path";

interface Label {
  name: string;
  color: string;
  description: string;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const named = args.indexOf("--repo");
const repo = named === -1 ? undefined : args[named + 1];
if (named !== -1 && !repo) {
  console.error("--repo takes owner/name.");
  process.exit(2);
}

const labels = (await Bun.file(join(import.meta.dir, "../.github/labels.json")).json()) as Label[];
let failed = 0;
for (const label of labels) {
  const command = [
    "gh",
    "label",
    "create",
    label.name,
    "--color",
    label.color,
    "--description",
    label.description,
    "--force",
    ...(repo ? ["--repo", repo] : []),
  ];
  if (dryRun) {
    console.log(command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" "));
    continue;
  }
  const made = Bun.spawn(command, { stdio: ["ignore", "ignore", "inherit"] });
  if ((await made.exited) === 0) console.log(`ok  ${label.name}`);
  else failed += 1;
}
if (failed > 0) {
  console.error(
    `${failed} of ${labels.length} labels could not be set. Is \`gh auth status\` signed in?`,
  );
  process.exit(1);
}
