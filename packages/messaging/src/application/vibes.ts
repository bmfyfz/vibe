import { type Clock, newId } from "@vibe/kernel";

import { vibeNotFound } from "../domain/errors.ts";
import { DEFAULT_VIBE, parseVibeName } from "../domain/vibe.ts";
import type { VibeRecord, VibeRepository } from "./ports.ts";

export class Vibes {
  constructor(
    private readonly repository: VibeRepository,
    private readonly clock: Clock,
  ) {}

  /** Finds a team's vibe by name. `general` always exists: it's created the first time it's asked for. */
  async resolve(teamId: string, input: string = DEFAULT_VIBE): Promise<VibeRecord> {
    const { repository, clock } = this;
    const name = parseVibeName(input);

    const found = await repository.findByName(teamId, name);
    if (found) return found;
    if (name !== DEFAULT_VIBE) throw vibeNotFound(name);

    const now = clock.now();
    await repository.addIfMissing({ id: newId("vb", now), teamId, name, createdAt: now });
    const created = await repository.findByName(teamId, name);
    if (!created) throw vibeNotFound(name);
    return created;
  }

  /** A vibe by its ID, for work that isn't a request and so has no team to look in. */
  find(id: string): Promise<VibeRecord | null> {
    return this.repository.findById(id);
  }

  list(teamId: string): Promise<VibeRecord[]> {
    return this.repository.list(teamId);
  }
}
