import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { configPath } from "./config.ts";

/**
 * The claims this machine holds, one file each, kept apart by who claimed: a
 * claim made as one profile can't be settled as another, or as yourself.
 */
export interface StoredClaim {
  claim: string;
  expiresAt: string;
}

function claimPath(profile: string | null, taskId: string): string {
  const who = profile === null ? "_self" : profile.toLowerCase();
  return join(dirname(configPath()), "claims", who, `${taskId}.json`);
}

export async function saveClaim(
  profile: string | null,
  taskId: string,
  stored: StoredClaim,
): Promise<void> {
  const path = claimPath(profile, taskId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
}

export async function loadClaim(profile: string | null, taskId: string): Promise<string | null> {
  try {
    const stored = JSON.parse(await readFile(claimPath(profile, taskId), "utf8")) as StoredClaim;
    return typeof stored.claim === "string" ? stored.claim : null;
  } catch {
    return null;
  }
}

export async function dropClaim(profile: string | null, taskId: string): Promise<void> {
  await rm(claimPath(profile, taskId), { force: true });
}
