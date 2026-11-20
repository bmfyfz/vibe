import type { Permission } from "@vibe/sdk";

/**
 * What you can do in a channel, read from what `whoami` says you can do at
 * each pattern: the most specific pattern that holds the channel decides, as
 * it does on the server. The page uses it to leave out what would be refused.
 * The server still decides: this only keeps controls honest.
 */
export function canIn(
  can: Readonly<Record<string, readonly Permission[]>> | undefined,
  channel: string | null,
): ReadonlySet<Permission> {
  if (!can) return new Set();
  if (channel === null || channel.endsWith("/")) {
    // Not one channel: what you can do somewhere is what may be offered.
    return new Set(Object.values(can).flat());
  }
  let best: { rank: number; list: readonly Permission[] } | null = null;
  for (const [pattern, list] of Object.entries(can)) {
    const rank =
      pattern === channel
        ? Number.POSITIVE_INFINITY
        : pattern === "*"
          ? 0
          : pattern.endsWith("/") && channel.startsWith(pattern)
            ? pattern.length
            : -1;
    if (rank >= 0 && (best === null || rank > best.rank)) best = { rank, list };
  }
  return new Set(best?.list ?? []);
}
