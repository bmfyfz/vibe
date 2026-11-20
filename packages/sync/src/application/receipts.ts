import type { BeginUnitOfWork, Clock, EventLog } from "@vibe/kernel";
import { type ThreadRepository, toRecords } from "@vibe/messaging";

// A receipt that loses a race for its thread's version is decided again from
// what the winner left. Nothing is decided here but the version it takes.
const MAX_ATTEMPTS = 8;

/** What sync records in the vibe's event log about a thread or one of its messages. */
export type ReceiptKind =
  /** A thread was connected with a thread on a platform. */
  | "thread.synced"
  /** A platform accepted a message's copy. Bookkeeping: followers are spared it unless they ask. */
  | "message.synced"
  /** A delivery was given up on after its retries. */
  | "message.sync_failed";

/**
 * Records what sync did on the thread it did it to, the way the Tasks context
 * records a task's changes: as a note that takes the thread's next version,
 * so it is ordered with the thread's messages and reaches whoever follows them.
 */
export class Receipts {
  constructor(
    private readonly threads: ThreadRepository,
    private readonly eventLog: EventLog,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * Records one receipt. A courtesy: the delivery it tells of has happened
   * whether or not this lands, so a failure is logged and goes no further.
   *
   * @param messageId The message it concerns, in the thread it is recorded on.
   * @param actorId The service the sync entry acts as.
   */
  async note(
    vibeId: string,
    messageId: string,
    kind: ReceiptKind,
    actorId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const thread = await this.threads.findByMessage(vibeId, messageId);
        if (!thread) return;
        thread.note({ as: kind, actorId, about: messageId, payload, now: this.clock.now() });
        const events = thread.pullEvents();
        const uow = this.begin();
        this.eventLog.append(uow, toRecords(thread, events));
        this.threads.save(uow, thread, events);
        try {
          await uow.commit();
          return;
        } catch (error) {
          if (!this.eventLog.isVersionConflict(error)) throw error;
        }
      }
      console.error(`Recording ${kind} on ${messageId} kept losing its thread's version.`);
    } catch (error) {
      console.error(`Recording ${kind} on ${messageId} failed.`, error);
    }
  }
}
