import { afterAll, describe, expect, test } from "bun:test";

import { harness } from "./harness.ts";
import { syncEntries } from "./sync-helpers.ts";

const vibe = harness();
const { github } = vibe.platforms;

const LIMIT = 2 * 1024 * 1024;
const CHUNK = 64 * 1024;

/**
 * A body sent in pieces, with no length declared, and a count of how many
 * pieces were taken from it: what shows how much of it was read.
 */
function streamed(pieces: number, piece: Uint8Array = new Uint8Array(CHUNK).fill(97)) {
  let taken = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (taken === pieces) return controller.close();
      taken += 1;
      controller.enqueue(piece);
    },
  });
  return { body, taken: () => taken };
}

/** Posts a streamed body to an entry's webhook address. */
function post(source: { id: string }, body: ReadableStream<Uint8Array>, headers = {}) {
  // `duplex` is what lets a request's body be a stream. The standard type doesn't know it yet.
  const init = { method: "POST", headers, body, duplex: "half" } as RequestInit;
  return vibe.fetch(`${vibe.url}/v1/sync/webhooks/${source.id}`, init);
}

describe("the size of a webhook", () => {
  const entries = syncEntries(vibe);
  afterAll(() => entries.removeAll());
  const nowhere = { id: "src_00000000000000000000000000" };

  // How much of a body the app took can only be seen where the stream is
  // handed to it directly. Between this process and a Vibe that is running
  // there is a network, and under `vite dev` a proxy, which take the body
  // from the sender whatever the Vibe then does with it.
  test.skipIf(!vibe.canJump)(
    "a body that declares no length is given up on once it passes the limit",
    async () => {
      // Sixteen times the limit, were it all read.
      const { body, taken } = streamed((16 * LIMIT) / CHUNK);
      const response = await post(nowhere, body);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: "too_large" });
      // The limit, and the piece that crossed it: nowhere near the whole body.
      expect(taken() * CHUNK).toBeGreaterThanOrEqual(LIMIT);
      expect(taken() * CHUNK).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
    },
  );

  test("a declared length over the limit is refused", async () => {
    const send = () =>
      vibe.fetch(`${vibe.url}/v1/sync/webhooks/${nowhere.id}`, {
        method: "POST",
        body: new Uint8Array(LIMIT + 1),
      });
    let response = await send();
    // The answer comes before the body was read. The proxy `vite dev` puts in
    // front of a Worker sometimes loses such an answer, and says 500 itself.
    for (let n = 0; n < 8 && !vibe.canJump && response.status === 500; n++) response = await send();
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "too_large" });
  });

  test.skipIf(!vibe.near)(
    "a webhook within the limit is taken with or without a declared length",
    async () => {
      const repository = github.repository("sizes");
      const channel = vibe.channel("prs");
      const { owner, source } = await entries.add(
        "github",
        { [repository]: channel },
        { token: null },
      );
      const signed = github.signed("pull_request", {
        ...github.about(repository),
        action: "opened",
        number: 7,
        // Text that is more bytes than characters: the limit and the signature are over bytes.
        pull_request: github.pull(repository, 7, { title: "Streamed ✓ in pieces" }),
      });
      const bytes = new TextEncoder().encode(signed.body);
      const middle = Math.floor(bytes.length / 2) + 1;
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 0) controller.enqueue(bytes.slice(0, middle));
          else if (sent === 1) controller.enqueue(bytes.slice(middle));
          else controller.close();
          sent += 1;
        },
      });

      const response = await post(source, body, signed.headers);
      expect(response.status).toBe(200);
      const [thread] = (await owner.threads({ channel })).threads;
      expect(thread?.message.text).toStartWith("**Streamed ✓ in pieces**");
    },
  );
});
