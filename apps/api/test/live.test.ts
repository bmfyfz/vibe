import { describe, expect, test } from "bun:test";

import { vibe as connect, type VibeEvent } from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
/** These need a Vibe that holds sockets: run them against `cf dev`. */
const live = test.skipIf(!vibe.live);
const liveUrl = `${vibe.url.replace(/^http/, "ws")}/v1/vibes/general/live`;

type Listener = (event: { data?: unknown }) => void;
interface Socket {
  addEventListener(type: string, listener: Listener): void;
  send(data: string): void;
  close(): void;
}
/** Bun's WebSocket takes headers with the handshake, which the standard type doesn't say. */
const WebSocketWithHeaders = WebSocket as unknown as new (
  url: string,
  options: { headers: Record<string, string> },
) => Socket;

/** Opens a live socket as a token's owner, and collects what the hub sends on it. */
function listen(token: string) {
  const socket = new WebSocketWithHeaders(liveUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  const heard: unknown[] = [];
  let wake: (() => void) | undefined;
  socket.addEventListener("message", (event) => {
    heard.push(event.data);
    wake?.();
  });
  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true));
    socket.addEventListener("error", () => resolve(false));
    socket.addEventListener("close", () => resolve(false));
  });
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve((event as { code?: number }).code ?? 0));
  });
  return {
    opened,
    /** Resolves with the close code once the socket has closed. */
    closed,
    send: (data: string) => socket.send(data),
    heard,
    /** Resolves once the socket has heard `count` messages, or `ms` have passed. */
    async until(count: number, ms: number): Promise<void> {
      const deadline = Date.now() + ms;
      while (heard.length < count && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
    close: () => socket.close(),
  };
}

describe("the live socket", () => {
  test("is somewhere to ask for, even where nothing holds sockets", async () => {
    const { token } = await vibe.join();
    const anonymous = await vibe.fetch(`${vibe.url}/v1/vibes/general/live`);
    expect(anonymous.status).toBe(401);

    const plain = await vibe.fetch(`${vibe.url}/v1/vibes/general/live`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await plain.json()) as { code: string };
    // A Vibe with a hub wants a WebSocket. One without says so, and clients long-poll.
    expect([plain.status, body.code]).toEqual(
      vibe.live ? [400, "invalid_request"] : [404, "live_unavailable"],
    );
  });

  live("pokes with a number when something is written, and with nothing else", async () => {
    const { client: ada, token } = await vibe.join();
    const socket = listen(token);
    try {
      expect(await socket.opened).toBe(true);
      const started = Date.now();
      const root = await ada.post(vibe.channel(), "the deploy is green");
      await socket.until(1, 5000);
      // Long before any client's own re-poll would have come round.
      expect(Date.now() - started).toBeLessThan(5000);
      expect(socket.heard.length).toBeGreaterThanOrEqual(1);

      await ada.react(root.id, "eyes");
      await socket.until(2, 5000);
      for (const message of socket.heard) expect(message).toMatch(/^\d+$/);
      // Each number is how far the log got, so they only go up for one writer.
      const [first, second] = socket.heard.map(Number);
      expect(second).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY);
    } finally {
      socket.close();
    }
  });

  live("tells a caller shut out of a channel that something happened, and never what", async () => {
    const owner = await vibe.owner();
    const { client: eve, token } = await vibe.join();
    const secret = vibe.channel("secret");
    await owner.createChannel(secret, { private: true });
    const { cursor } = await eve.poll();

    const socket = listen(token);
    try {
      expect(await socket.opened).toBe(true);
      await owner.post(secret, "the quarterly numbers");
      await socket.until(1, 5000);
      expect(socket.heard.length).toBeGreaterThanOrEqual(1);
      for (const message of socket.heard) expect(message).toMatch(/^\d+$/);
      // What it then asks for goes through the feed, which shows it nothing.
      expect((await eve.poll({ after: cursor })).events).toEqual([]);
    } finally {
      socket.close();
    }
  });

  live("is refused to a caller without a token", async () => {
    const socket = listen("vibe_sk_not-a-real-token");
    expect(await socket.opened).toBe(false);
    socket.close();
  });

  live("only listens: a socket that says anything is closed", async () => {
    const { token } = await vibe.join();
    const socket = listen(token);
    expect(await socket.opened).toBe(true);
    socket.send("what happened?");
    expect(await socket.closed).toBe(1008);
    expect(socket.heard).toEqual([]);
  });

  live("wakes a waiting client with a poke, not with the fallback timer", async () => {
    const { client: ada } = await vibe.join();
    const channel = vibe.channel();
    const waits: number[] = [];
    // A client that would not ask again by itself for ten minutes, and whose
    // every request for events is recorded with how long it offered to wait.
    const bob = connect({
      url: vibe.url,
      token: (await vibe.join()).token,
      live: { repoll: "10m" },
      fetch: (input, init) => {
        const { pathname, searchParams } = new URL(input);
        if (pathname.endsWith("/events")) waits.push(Number(searchParams.get("wait")));
        return fetch(input, init);
      },
    });

    const waiting = bob.wait({ channel }, { timeout: "30s" });
    // Long enough for the socket to open and the first look to come back empty.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(waits).toEqual([0]);

    const started = Date.now();
    const root = await ada.post(channel, "wake up");
    const event = await waiting;
    const took = Date.now() - started;

    expect(event?.message?.id).toBe(root.id);
    // No request ever waited on the server, and the client's own timer was ten
    // minutes off: only the poke can have brought it back this soon.
    expect(waits.every((wait) => wait === 0)).toBe(true);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(took).toBeLessThan(5000);
  });

  live("follows events over the socket, each as it is written and in order", async () => {
    const { client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel();
    const controller = new AbortController();
    const seen: VibeEvent[] = [];
    const following = (async () => {
      for await (const event of bob.events({ channel }, { signal: controller.signal })) {
        seen.push(event);
        if (seen.length === 3) controller.abort();
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 700));

    const root = await ada.post(channel, "one");
    await ada.reply(root.id, "two");
    await ada.react(root.id, "eyes");
    await following;
    expect(seen.map((event) => event.type)).toEqual([
      "message.posted",
      "message.posted",
      "reaction.added",
    ]);
    expect(seen.map((event) => event.message?.text)).toEqual(["one", "two", "one"]);
  });
});
