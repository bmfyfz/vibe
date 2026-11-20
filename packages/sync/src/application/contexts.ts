import type { Credentials, Source } from "../domain/source.ts";
import type { Platform, PlatformContext, Platforms, Send } from "./platform.ts";
import type { StoredSource, Vault } from "./ports.ts";

/** A sync entry with what it takes to act on its platform. */
export interface Opened {
  platform: Platform;
  context: PlatformContext;
}

/** Opens sync entries: unseals their credentials and finds their platform. */
export class Contexts {
  constructor(
    private readonly vault: Vault | null,
    private readonly platforms: Platforms,
    private readonly send: Send,
  ) {}

  /** Whether this Vibe can keep credentials at all. */
  get available(): boolean {
    return this.vault !== null;
  }

  platformOf(source: Pick<Source, "platform">): Platform {
    return this.platforms[source.platform];
  }

  /** @throws When the credentials were sealed under another key: the deployment's secret changed. */
  async open(source: StoredSource): Promise<Opened> {
    if (!this.vault) throw new Error("This Vibe has no key to open credentials with.");
    const credentials = JSON.parse(await this.vault.open(source.sealed, source.id)) as Credentials;
    return {
      platform: this.platformOf(source),
      context: { source, credentials, send: this.send },
    };
  }

  /** Seals credentials for the entry they belong to. */
  async seal(sourceId: string, credentials: Credentials): Promise<string | null> {
    return this.vault ? this.vault.seal(JSON.stringify(credentials), sourceId) : null;
  }

  get sender(): Send {
    return this.send;
  }
}
