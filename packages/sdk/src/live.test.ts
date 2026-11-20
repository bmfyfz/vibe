import { describe, expect, test } from "bun:test";

import type { EventsPage, VibeEvent } from "@vibe/contracts";

import { type LiveSocket, vibe } from "./index.ts";

/** A socket the test drives: it opens, hears, and closes when told to. */
class FakeSocket implements LiveSocket {
  private readonly listeners = new Map<string, (() => void)[]>();
  closed = false;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: "open" | "message" | "close" | "error"): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

const event = (n: number): VibeEvent => ({
  cursor: `cur_${n}`,
  type: "message.posted",
  createdAt: new Date(0).toISOString(),
  payload: {},
  message: null,
  actor: {
    actor: "vibe:user:u_1",
    handle: "ada",
    name: "ada",
    principal: "vibe:user:u_1",
    profile: null,
  },
});

/**
 * A Vibe that answers `/events` with whatever the test queued, or with nothing
 * new, and remembers how long each request offered to wait.
 */
function setup(
  options: { opens?: "open" | "error" | "never"; repoll?: number; delay?: number } = {},
) {
  const sockets: FakeSocket[] = [];
  const waits: number[] = [];
  const pages: EventsPage[] = [];
  let asked: (() => void) | undefined;
  const client = vibe({
    url: "http://vibe.test",
    token: "vibe_sk_test",
    profile: "fx",
    live: { repoll: options.repoll ?? 60_000 },
    webSocket: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      const opens = options.opens ?? "open";
      if (opens !== "never") setTimeout(() => socket.emit(opens), 0);
      return socket;
    },
    fetch: async (input) => {
      waits.push(Number(new URL(input).searchParams.get("wait")));
      asked?.();
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay));
      return Response.json(pages.shift() ?? { events: [], cursor: "cur_0" });
    },
  });
  return {
    client,
    sockets,
    waits,
    pages,
    /** Resolves the next time the handle asks for events. */
    nextAsk: () => new Promise<void>((resolve) => (asked = resolve)),
  };
}
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a handle with a live socket", () => {
  test("asks without waiting, sleeps, and asks again when it is poked", async () => {
    const { client, sockets, waits, pages, nextAsk } = setup();
    const waiting = client.wait({ channel: "dev" }, { timeout: "5s" });
    await nextAsk();
    await tick();
    expect(waits).toEqual([0]);
    expect(sockets).toHaveLength(1);

    pages.push({ events: [event(7)], cursor: "cur_7" });
    sockets[0]?.emit("message");
    expect((await waiting)?.cursor).toBe("cur_7");
    // Never a long-poll: it was the poke that woke it.
    expect(waits).toEqual([0, 0]);
    expect(sockets[0]?.closed).toBe(true);
  });

  test("connects to the vibe's live route as itself", async () => {
    const { client, sockets } = setup();
    await client.wait({}, { timeout: 20 });
    expect(sockets[0]?.url).toBe("ws://vibe.test/v1/vibes/general/live");
    expect(sockets[0]?.headers).toEqual({
      authorization: "Bearer vibe_sk_test",
      "vibe-profile": "fx",
    });
  });

  test("keeps a poke that lands while it is asking", async () => {
    const { client, sockets, waits, pages, nextAsk } = setup({ delay: 20 });
    const waiting = client.wait({}, { timeout: "5s" });
    await nextAsk();
    // The first answer is already on its way, with nothing in it.
    pages.push({ events: [], cursor: "cur_1" }, { events: [event(2)], cursor: "cur_2" });
    sockets[0]?.emit("message");
    expect((await waiting)?.cursor).toBe("cur_2");
    expect(waits).toEqual([0, 0]);
  });

  test("asks again by itself when no poke comes, in case one was missed", async () => {
    const { client, waits, pages, nextAsk } = setup({ repoll: 30 });
    const waiting = client.wait({}, { timeout: "5s" });
    await nextAsk();
    pages.push({ events: [event(3)], cursor: "cur_3" });
    const started = Date.now();
    expect((await waiting)?.cursor).toBe("cur_3");
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(waits).toEqual([0, 0]);
  });

  test("gives up at its timeout, without a last long wait", async () => {
    const { client, waits } = setup();
    const started = Date.now();
    expect(await client.wait({}, { timeout: 40 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(new Set(waits)).toEqual(new Set([0]));
  });

  test("waits with a long-poll when the socket can't be opened", async () => {
    const { client, sockets, waits, pages } = setup({ opens: "error" });
    pages.push({ events: [event(1)], cursor: "cur_1" });
    expect((await client.wait({}, { timeout: "5s" }))?.cursor).toBe("cur_1");
    // One request, which waits for as long as there is left.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(4);
    expect(sockets).toHaveLength(1);
  });

  test("goes back to long-polls when the socket closes under it", async () => {
    const { client, sockets, waits, pages, nextAsk } = setup();
    const controller = new AbortController();
    const seen: string[] = [];
    const following = (async () => {
      for await (const each of client.events({}, { signal: controller.signal })) {
        seen.push(each.cursor);
        if (seen.length === 2) controller.abort();
      }
    })();
    await nextAsk();
    await tick();
    pages.push({ events: [event(1)], cursor: "cur_1" });
    sockets[0]?.emit("message");
    await tick(20);
    expect(seen).toEqual(["cur_1"]);

    // The socket drops. The next request does the waiting itself, and the
    // socket isn't tried again straight away.
    pages.push({ events: [event(2)], cursor: "cur_2" });
    sockets[0]?.emit("close");
    await following;
    expect(seen).toEqual(["cur_1", "cur_2"]);
    expect(waits.at(-1)).toBe(20);
    expect(waits.slice(0, -1).every((wait) => wait === 0)).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  test("with live off, never opens a socket", async () => {
    const waits: number[] = [];
    let opened = 0;
    const client = vibe({
      url: "http://vibe.test",
      live: false,
      webSocket: () => {
        opened += 1;
        return new FakeSocket("", {});
      },
      fetch: async (input) => {
        waits.push(Number(new URL(input).searchParams.get("wait")));
        return Response.json({ events: [event(1)], cursor: "cur_1" });
      },
    });
    await client.wait({}, { timeout: "5s" });
    expect(opened).toBe(0);
    expect(waits[0]).toBeGreaterThan(4);
  });
});
