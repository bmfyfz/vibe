import { type SyncMapInput, type SyncSource, VibeError, type VibeHandle } from "@vibe/sdk";

import type { Harness } from "./harness.ts";

export const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
export const failing = (work: Promise<unknown>) => work.then(() => "nothing", code);

/** A sync entry made for a test, with who made it and the service it acts as. */
export interface Syncing {
  owner: VibeHandle;
  /** The service's name, which is its handle. */
  service: string;
  key: string;
  source: SyncSource;
}

/**
 * What a test file's sync entries are made and cleaned up with. A vibe holds
 * only so many entries, and each reads the whole log, so a suite that runs
 * against a Vibe that persists removes what it made.
 */
export function syncEntries(vibe: Harness) {
  const made: { owner: VibeHandle; key: string }[] = [];
  let admin: VibeHandle | undefined;

  const owner = async () => {
    admin ??= await vibe.owner();
    return admin;
  };

  return {
    owner,
    /** Adds an entry for a platform, acting as a service of its own. */
    async add(
      platform: "slack" | "github" | "linear",
      map: Record<string, SyncMapInput>,
      options: { token?: string | null; service?: string } = {},
    ): Promise<Syncing> {
      const by = await owner();
      const service = options.service ?? vibe.name("svc");
      if (options.service === undefined) await by.createService({ name: service });
      const key = vibe.name(platform);
      const { slack, github, linear } = vibe.platforms;
      const tokens = { slack: slack.token, github: github.token, linear: linear.token };
      const secrets = {
        slack: slack.signingSecret,
        github: github.webhookSecret,
        linear: linear.webhookSecret,
      };
      const token = options.token === undefined ? tokens[platform] : options.token;
      const source = await by.createSource({
        key,
        platform,
        service,
        map,
        credentials: { ...(token === null ? {} : { token }), secret: secrets[platform] },
        api: vibe.platformApi(platform),
      });
      made.push({ owner: by, key });
      return { owner: by, service, key, source };
    },
    /** Removes every entry this file made. For `afterAll`. */
    async removeAll(): Promise<void> {
      for (const { owner: by, key } of made) await by.deleteSource(key).catch(() => {});
      await vibe.platforms.stop();
    },
  };
}

/**
 * Lets Vibe sync, and resolves once `check` holds. In this process nothing
 * syncs until a pass is asked for. A running Vibe syncs by itself, and asking
 * for a pass does no harm.
 */
export async function eventually<T>(
  vibe: Harness,
  check: () => T | Promise<T>,
  within = 15_000,
): Promise<T> {
  const deadline = Date.now() + within;
  for (;;) {
    await vibe.tick();
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** Lets Vibe sync whatever it would, and resolves when it has had its chance. For what must not happen. */
export async function settle(vibe: Harness): Promise<void> {
  await vibe.tick();
  await new Promise((resolve) => setTimeout(resolve, vibe.canJump ? 20 : 700));
  await vibe.tick();
}

/** Sends a webhook and expects it taken. */
export async function deliver(
  vibe: Harness,
  source: { id: string },
  signed: { body: string; headers: Record<string, string> },
): Promise<void> {
  const response = await vibe.webhook(source, signed);
  if (response.status !== 200) {
    throw new Error(`The webhook was answered ${response.status}: ${await response.text()}`);
  }
}
