import type { Caller } from "@vibe/identity";
import type { UnitOfWork } from "@vibe/kernel";

import type { Thread, ThreadEvent } from "../domain/thread.ts";

/** What a follower adds to the unit of work that commits the thread. */
export type Alongside = (uow: UnitOfWork) => void;

export interface ThreadChange {
  thread: Thread;
  /** What is about to be committed on the thread. */
  events: readonly ThreadEvent[];
  caller: Caller;
  now: number;
}

/**
 * A context that keeps state on threads and must change with them: a task is
 * canceled when its root message is deleted. A follower is told of a change
 * before it commits, may record more on the thread with `thread.note`, and
 * returns what to write in the same unit of work, so both land or neither does.
 */
export interface ThreadFollower {
  follow(change: ThreadChange): Promise<Alongside | null>;
}

/** The followers of every thread. A context adds itself when it is wired. */
export class ThreadFollowers {
  private readonly followers: ThreadFollower[] = [];

  add(follower: ThreadFollower): void {
    this.followers.push(follower);
  }

  async follow(change: ThreadChange): Promise<Alongside> {
    const alongside: Alongside[] = [];
    for (const follower of this.followers) {
      const write = await follower.follow(change);
      if (write) alongside.push(write);
    }
    return (uow) => {
      for (const write of alongside) write(uow);
    };
  }
}
