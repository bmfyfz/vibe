import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What `vibe login` remembers between commands. */
export interface Config {
  url?: string | undefined;
  token?: string | undefined;
  name?: string | undefined;
}

export function configPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(base, "vibe", "config.json");
}

export async function loadConfig(): Promise<Config> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Config) : {};
  } catch {
    return {};
  }
}

/** Writes the config so only its owner can read it: it holds a token. */
export async function saveConfig(config: Config): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
