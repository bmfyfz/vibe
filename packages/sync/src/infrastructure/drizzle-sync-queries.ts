import { encodeCursor } from "@vibe/activity";
import type { SyncedView, SyncSource as SourceView } from "@vibe/contracts";
import { and, asc, type Db, eq, schema, sql } from "@vibe/store";

import type { SyncQueries } from "../application/ports.ts";
import { labelOf } from "../domain/source.ts";
import { formatTarget } from "../domain/target.ts";

const { actors, syncCursors, syncMessages, syncSources, syncThreads } = schema;

/** Where a platform's webhooks for an entry are sent, on the Vibe's own URL. */
export function webhookPath(sourceId: string): string {
  return `/v1/sync/webhooks/${sourceId}`;
}

export class DrizzleSyncQueries implements SyncQueries {
  constructor(private readonly db: Db) {}

  async sources(vibeId: string): Promise<SourceView[]> {
    return this.rows(eq(syncSources.vibeId, vibeId));
  }

  async source(vibeId: string, id: string): Promise<SourceView | null> {
    const [row] = await this.rows(and(eq(syncSources.vibeId, vibeId), eq(syncSources.id, id)));
    return row ?? null;
  }

  async synced(vibeId: string, threadId: string, messageId: string): Promise<SyncedView> {
    const joins = await this.db
      .select({
        thread: syncThreads,
        key: syncSources.key,
        platform: syncSources.platform,
        config: syncSources.config,
        // A thread whose ID was ours to give has it on record before the platform has the thread.
        starting: sql<number>`EXISTS (
          SELECT 1 FROM sync_messages first
          WHERE first.sync_thread_id = ${syncThreads.id} AND first.state = 'pending'
            AND first.platform_message = ${syncThreads.platformThread})`,
        copy: sql<string | null>`(
          SELECT copy.url FROM sync_messages copy
          WHERE copy.sync_thread_id = ${syncThreads.id} AND copy.message_id = ${messageId}
            AND copy.state = 'done')`,
      })
      .from(syncThreads)
      .innerJoin(syncSources, eq(syncSources.id, syncThreads.sourceId))
      .where(and(eq(syncThreads.vibeId, vibeId), eq(syncThreads.threadId, threadId)))
      .orderBy(asc(syncThreads.createdAt), asc(syncThreads.id));

    const shown = new Map(
      joins.map(({ thread, key, config }) => [
        thread.id,
        formatTarget(key, labelOf(config, thread.platformChannel), thread.platformThread),
      ]),
    );
    const failures = await this.db
      .select({
        message: syncMessages.messageId,
        join: syncMessages.syncThreadId,
        key: syncSources.key,
        error: syncMessages.lastError,
        at: syncMessages.updatedAt,
      })
      .from(syncMessages)
      .innerJoin(syncThreads, eq(syncThreads.id, syncMessages.syncThreadId))
      .innerJoin(syncSources, eq(syncSources.id, syncMessages.sourceId))
      .where(
        and(
          eq(syncThreads.vibeId, vibeId),
          eq(syncThreads.threadId, threadId),
          eq(syncMessages.state, "failed"),
          // Shown until a later delivery to the same platform thread goes through.
          sql`NOT EXISTS (
            SELECT 1 FROM sync_messages later
            WHERE later.sync_thread_id = ${syncMessages.syncThreadId} AND later.state = 'done'
              AND later.direction = 'out' AND later.seq > ${syncMessages.seq})`,
        ),
      )
      .orderBy(asc(syncMessages.seq));

    return {
      targets: joins.map(({ thread, key, platform, starting, copy }) => ({
        source: key,
        platform,
        target: shown.get(thread.id) ?? key,
        state:
          thread.state === "failed"
            ? "failed"
            : thread.platformThread === null || starting === 1
              ? "starting"
              : "synced",
        url: thread.url,
        copy,
      })),
      failures: failures.map((failure) => ({
        message: failure.message,
        source: failure.key,
        target: shown.get(failure.join) ?? failure.key,
        error: failure.error,
        at: new Date(failure.at).toISOString(),
      })),
    };
  }

  private async rows(where: ReturnType<typeof and>): Promise<SourceView[]> {
    const rows = await this.db
      .select({
        source: syncSources,
        seq: syncCursors.seq,
        handle: actors.handle,
        pending: sql<number>`(
          SELECT count(*) FROM sync_messages copy
          WHERE copy.source_id = ${syncSources.id} AND copy.state = 'pending')`,
        failed: sql<number>`(
          SELECT count(*) FROM sync_messages copy
          WHERE copy.source_id = ${syncSources.id} AND copy.state = 'failed')`,
      })
      .from(syncSources)
      .innerJoin(syncCursors, eq(syncCursors.sourceId, syncSources.id))
      .leftJoin(actors, eq(actors.id, syncSources.principal))
      .where(where)
      .orderBy(asc(syncSources.key));
    return rows.map(({ source, seq, handle, pending, failed }) => ({
      id: source.id,
      key: source.key,
      platform: source.platform,
      service: { id: source.principal, handle: handle ?? "" },
      mappings: source.config.mappings.map((mapping) => ({
        platform: mapping.label,
        channel: mapping.channel,
        only: mapping.only ?? null,
        out: mapping.out,
      })),
      state: source.state,
      reason: source.reason,
      webhook: webhookPath(source.id),
      api: source.config.api,
      cursor: encodeCursor(seq),
      pending,
      failed,
      createdAt: new Date(source.createdAt).toISOString(),
    }));
  }
}
