import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import {
  type Grant,
  verifyDelivery,
  VibeError,
  type VibeHandle,
  type WatcherDelivery,
} from "@vibe/sdk";

import { harness } from "./harness.ts";

const vibe = harness();
const code = (error: unknown) => (error instanceof VibeError ? error.code : String(error));
const failing = (work: Promise<unknown>) => work.then(() => "nothing", code);

/** One request Vibe made to a watcher's URL, and what the receiver answered. */
interface Attempt {
  headers: Headers;
  body: string;
  delivery: WatcherDelivery;
  answered: number;
}

/**
 * A server that stands in for a watcher's endpoint. It records every request
 * and answers 200, or whatever `answer` says it should.
 */
function receiver() {
  const attempts: Attempt[] = [];
  let answer: (attempt: Attempt) => number | Promise<number> = () => 200;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text();
      const attempt: Attempt = {
        headers: request.headers,
        body,
        delivery: JSON.parse(body) as WatcherDelivery,
        answered: 200,
      };
      attempt.answered = await answer(attempt);
      attempts.push(attempt);
      return new Response(null, { status: attempt.answered });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/hooks/vibe`,
    attempts,
    /** The deliveries the receiver accepted, in the order they arrived. */
    accepted: () => attempts.filter((attempt) => attempt.answered < 300),
    answerWith(next: typeof answer) {
      answer = next;
    },
    /**
     * Gives Vibe the chance to deliver, and resolves once the receiver has
     * seen `count` requests. Against a running Vibe they arrive by themselves,
     * and asking for a pass does no harm.
     */
    async saw(count: number, within = 15_000): Promise<Attempt[]> {
      const deadline = Date.now() + within;
      while (attempts.length < count) {
        await vibe.tick();
        if (attempts.length >= count) break;
        if (Date.now() > deadline) {
          throw new Error(`The receiver saw ${attempts.length} request(s), not ${count}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return attempts;
    },
    /** Lets Vibe deliver whatever it would, and resolves when it has had its chance. */
    async settle(): Promise<void> {
      await vibe.tick();
      await new Promise((resolve) => setTimeout(resolve, vibe.canJump ? 20 : 500));
    },
    stop: () => server.stop(true),
  };
}

describe.skipIf(!vibe.near)("watchers", () => {
  const grants: string[] = [];
  const receivers: ReturnType<typeof receiver>[] = [];
  const registered: { by: VibeHandle; name: string }[] = [];
  let admin: VibeHandle | undefined;
  const owner = async () => {
    admin ??= await vibe.owner();
    return admin;
  };
  const keep = (grant: Grant) => {
    grants.push(grant.id);
    return grant;
  };
  afterAll(async () => {
    for (const { by, name } of registered) await by.deleteWatcher(name).catch(() => {});
    for (const id of grants) await (await owner()).revokeGrant(id).catch(() => {});
    for (const each of receivers) await each.stop();
  });

  /** A receiver, and a watcher that posts a channel's events to it. */
  async function watching(
    by: VibeHandle,
    tail: Parameters<VibeHandle["createWatcher"]>[0] extends infer W
      ? Omit<W, "name" | "url">
      : never,
    name = vibe.name("w"),
  ) {
    const hook = receiver();
    receivers.push(hook);
    const made = await by.createWatcher({ name, url: hook.url, ...tail });
    registered.push({ by, name });
    return { hook, name, watcher: made.watcher, secret: made.secret };
  }

  test("registering takes manage at *, and shows the secret once", async () => {
    const { handle, client: ada } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const channel = vibe.channel();
    const { name, watcher, secret, hook } = await watching(ada, {
      channel,
      label: ["state=open|draft"],
      by: "me",
    });

    expect(secret).toStartWith("vibe_whsec_");
    expect(watcher).toMatchObject({
      name,
      url: hook.url,
      tail: { channel, labels: ["state=open|draft"], by: handle, re: null, mentions: null },
      by: { handle },
      state: "active",
      attempts: 0,
      deliveredAt: null,
    });
    const listed = await ada.watchers();
    expect(listed.find((each) => each.name === name)?.id).toBe(watcher.id);
    expect(JSON.stringify(listed)).not.toContain("vibe_whsec_");

    // A viewer has no manage. Neither has a service, by default, nor a narrowed token.
    const serviceName = vibe.name("svc");
    const service = vibe.connect(
      (await (await owner()).createService({ name: serviceName })).token,
    );
    const narrowed = ada.as("agent", { can: { "*": "all" } });
    for (const who of [viewer, service, narrowed]) {
      expect(await failing(who.createWatcher({ name: vibe.name("w"), url: hook.url }))).toBe(
        "forbidden",
      );
      expect(await failing(who.watchers())).toBe(who === narrowed ? "nothing" : "forbidden");
    }
    expect(await failing(narrowed.deleteWatcher(name))).toBe("forbidden");
    await (await owner()).deleteService(serviceName);

    expect(await failing(ada.createWatcher({ name, url: hook.url }))).toBe("watcher_exists");
    const refused = [
      { name: "Not A Name", url: hook.url },
      { name: vibe.name("w"), url: "http://example.com/hook" },
      { name: vibe.name("w"), url: "https://user:pass@example.com/hook" },
      { name: vibe.name("w"), url: "not a url" },
    ];
    for (const bad of refused)
      expect(await failing(ada.createWatcher(bad))).toBe("invalid_watcher");
    expect(
      await failing(ada.createWatcher({ name: vibe.name("w"), url: hook.url, label: ["=x"] })),
    ).toBe("invalid_label");
  });

  test("a watcher is posted each matching event, signed with its secret", async () => {
    const { handle, client: ada } = await vibe.join();
    const { client: bob } = await vibe.join();
    const channel = vibe.channel();
    const { hook, name, watcher, secret } = await watching(ada, { channel, label: ["kind=bug"] });

    const bug = await bob.post(channel, "checkout times out", { labels: { kind: "bug" } });
    await bob.post(channel, "lunch?");
    await bob.post(vibe.channel(), "a bug elsewhere", { labels: { kind: "bug" } });
    const reply = await ada.reply(bug.id, "on it");

    const [first, second] = await hook.saw(2);
    await hook.settle();
    expect(hook.attempts).toHaveLength(2);
    expect(first?.delivery).toMatchObject({
      watcher: { id: watcher.id, name },
      vibe: { name: "general" },
      event: { type: "message.posted", message: { id: bug.id, text: "checkout times out" } },
    });
    // A reply matches through its thread's root, as it does for `vibe tail`.
    expect(second?.delivery.event.message).toMatchObject({ id: reply.id, by: { handle } });

    for (const attempt of [first, second]) {
      if (!attempt) throw new Error("A delivery is missing.");
      const { headers, body, delivery } = attempt;
      const timestamp = headers.get("vibe-timestamp") ?? "";
      // The signature, worked out here with nothing of Vibe's.
      const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
      expect(headers.get("vibe-signature")).toBe(`v1=${expected}`);
      expect(headers.get("vibe-delivery")).toBe(delivery.id);
      expect(headers.get("vibe-watcher")).toBe(name);
      expect(headers.get("content-type")).toBe("application/json");
      expect(delivery.id).toBe(`${watcher.id}:${delivery.event.cursor}`);

      const proof = { secret, body, signature: headers.get("vibe-signature"), timestamp };
      expect(await verifyDelivery(proof)).toBe(true);
      expect(await verifyDelivery({ ...proof, secret: "vibe_whsec_wrong" })).toBe(false);
      expect(await verifyDelivery({ ...proof, body: `${body} ` })).toBe(false);
      expect(await verifyDelivery({ ...proof, now: Date.now() + 3_600_000 })).toBe(false);
    }

    const after = (await ada.watchers()).find((each) => each.id === watcher.id);
    expect(after).toMatchObject({ state: "active", attempts: 0, lastError: null });
    expect(after?.deliveredAt).not.toBeNull();
  });

  // In process nothing runs a pass unless the test asks. A running Vibe is
  // prompted by its own writes, and by its own waits: by a queue and its
  // delayed messages on a Worker, by timers under Bun. No one ticks here.
  test.skipIf(!vibe.live)(
    "a running Vibe delivers by itself, soon after the write, and tries again by itself",
    async () => {
      const { client: ada } = await vibe.join();
      const channel = vibe.channel();
      const { hook } = await watching(ada, { channel });
      let down = true;
      hook.answerWith(() => {
        if (!down) return 200;
        down = false;
        return 500;
      });
      const posted = await ada.post(channel, "no one asks for a pass");

      const seen = async (count: number, within: number) => {
        const deadline = Date.now() + within;
        while (hook.attempts.length < count && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return hook.attempts.map((attempt) => [
          attempt.delivery.event.message?.id,
          attempt.answered,
        ]);
      };
      expect(await seen(1, 10_000)).toEqual([[posted.id, 500]]);
      // The wait after a first failure is two seconds.
      expect(await seen(2, 15_000)).toEqual([
        [posted.id, 500],
        [posted.id, 200],
      ]);
    },
  );

  test("deliveries arrive in order, each at least once, after a failed attempt", async () => {
    const { client: ada } = await vibe.join();
    const channel = vibe.channel();
    const { hook, watcher, secret } = await watching(ada, { channel });

    // The endpoint is down for the first request it gets, and up after that.
    let down = true;
    hook.answerWith(() => {
      if (!down) return 200;
      down = false;
      return 503;
    });
    const posted = [
      await ada.post(channel, "one"),
      await ada.post(channel, "two"),
      await ada.post(channel, "three"),
    ];

    // The first attempt fails. Nothing newer goes out ahead of it.
    await hook.saw(1);
    await hook.settle();
    expect(hook.attempts.map((attempt) => attempt.delivery.event.message?.text)).toEqual(["one"]);
    expect(hook.accepted()).toEqual([]);
    expect((await ada.watchers()).find((each) => each.id === watcher.id)).toMatchObject({
      state: "failing",
      attempts: 1,
      lastStatus: 503,
      lastError: "The endpoint answered 503.",
    });

    // After the wait it is sent again, and then the rest, in the order they were written.
    await vibe.pass(2500);
    await hook.saw(4);
    await hook.settle();
    expect(
      hook.attempts.map((attempt) => [attempt.delivery.event.message?.id, attempt.answered]),
    ).toEqual([
      [posted[0]?.id, 503],
      [posted[0]?.id, 200],
      [posted[1]?.id, 200],
      [posted[2]?.id, 200],
    ]);
    // The retry is the same delivery, with the same ID to deduplicate on, signed afresh.
    const [failed, retried] = hook.attempts;
    expect(retried?.headers.get("vibe-delivery")).toBe(failed?.headers.get("vibe-delivery") ?? "");
    expect(retried?.body).toBe(failed?.body ?? "");
    for (const attempt of hook.attempts) {
      expect(
        await verifyDelivery({
          secret,
          body: attempt.body,
          signature: attempt.headers.get("vibe-signature"),
          timestamp: attempt.headers.get("vibe-timestamp"),
        }),
      ).toBe(true);
    }
    expect((await ada.watchers()).find((each) => each.id === watcher.id)).toMatchObject({
      state: "active",
      attempts: 0,
      retryAt: null,
      lastStatus: null,
    });
  });

  test("an endpoint that can't be reached is tried again, and loses nothing", async () => {
    const { client: ada } = await vibe.join();
    const channel = vibe.channel();
    const { hook, watcher } = await watching(ada, { channel });
    // Nothing listens there for now.
    await hook.stop();
    const posted = await ada.post(channel, "is anyone there?");
    await vibe.tick();
    const waitUntil = Date.now() + 10_000;
    let failing = (await ada.watchers()).find((each) => each.id === watcher.id);
    while (failing?.state !== "failing" && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await vibe.tick();
      failing = (await ada.watchers()).find((each) => each.id === watcher.id);
    }
    expect(failing).toMatchObject({ state: "failing", lastStatus: null });
    expect(failing?.lastError).not.toBeNull();

    // The same port comes back, and the delivery it missed arrives.
    const port = Number(new URL(hook.url).port);
    const seen: string[] = [];
    const back = Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(request) {
        seen.push(((await request.json()) as WatcherDelivery).event.message?.id ?? "");
        return new Response(null, { status: 204 });
      },
    });
    try {
      await vibe.pass(2500);
      const deadline = Date.now() + 15_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await vibe.tick();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(seen).toEqual([posted.id]);
    } finally {
      await back.stop(true);
    }
  });

  test("a watcher reads with its registrant's access, as it stands at each delivery", async () => {
    const by = await owner();
    const { handle: bobHandle, client: bob } = await vibe.join();
    const { handle: adaHandle, client: ada } = await vibe.join();
    const area = vibe.channel("area");
    const { hook } = await watching(bob, { channel: `${area}/` });

    const open = await ada.post(`${area}/open`, "anyone can read this");
    await hook.saw(1);

    // The area is closed to all but ada. Bob registered the watcher, and it can read what he can.
    const hers = keep(
      await by.createGrant({
        principals: [{ kind: "user", handle: adaHandle }],
        can: { [`${area}/`]: "all" },
      }),
    );
    keep(
      await by.createGrant({ principals: [{ kind: "everyone" }], can: { [`${area}/`]: "none" } }),
    );
    await ada.post(`${area}/open`, "not for bob any more");
    await hook.settle();
    expect(hook.attempts.map((attempt) => attempt.delivery.event.message?.id)).toEqual([open.id]);

    // Let back in, his watcher gets what is written from then on, and not what it was spared.
    await by.updateGrant(hers.id, { add: [{ kind: "user", handle: bobHandle }] });
    const again = await ada.post(`${area}/open`, "bob is back");
    await hook.saw(2);
    await hook.settle();
    expect(hook.attempts.map((attempt) => attempt.delivery.event.message?.id)).toEqual([
      open.id,
      again.id,
    ]);
  });

  // Only where the clock can be moved: the pass looks at its registrant's
  // access again once what it read is five seconds old.
  test.skipIf(!vibe.canJump)(
    "a channel closed while a slow pass is under way stops being delivered from",
    async () => {
      const by = await owner();
      const { client: bob } = await vibe.join();
      const { handle: adaHandle, client: ada } = await vibe.join();
      const area = vibe.channel("area");
      const { hook } = await watching(bob, { channel: `${area}/` });
      const first = await ada.post(`${area}/open`, "read by the pass, and delivered");
      await ada.post(`${area}/open`, "read by the pass, and closed before its turn");

      // The endpoint is slow, and while it thinks, the area is closed to all but ada.
      hook.answerWith(async () => {
        if (hook.attempts.length > 0) return 200;
        keep(
          await by.createGrant({
            principals: [{ kind: "user", handle: adaHandle }],
            can: { [`${area}/`]: "all" },
          }),
        );
        keep(
          await by.createGrant({
            principals: [{ kind: "everyone" }],
            can: { [`${area}/`]: "none" },
          }),
        );
        await vibe.pass(6000);
        return 200;
      });
      await hook.saw(1);
      await hook.settle();
      expect(hook.attempts.map((attempt) => attempt.delivery.event.message?.id)).toEqual([
        first.id,
      ]);
    },
  );

  test("a watcher's own writes never wake it, and anyone else's do", async () => {
    const { handle, client: ada } = await vibe.join();
    const channel = vibe.channel();
    const { hook, name } = await watching(ada, { channel });

    // The receiver answers in the thread, as the watcher: with the registrant's token and the watcher's name.
    const root = await ada.post(channel, "can someone triage this?");
    const [told] = await hook.saw(1);
    const asWatcher = ada.as(told?.delivery.watcher.name ?? "");
    const answer = await asWatcher.reply(root.id, "tracking it");
    await asWatcher.react(root.id, "eyes");
    expect(answer.by.handle).toBe(`${handle}/${name}`);
    await hook.settle();
    expect(hook.attempts).toHaveLength(1);

    // The same person under another name, or none, is someone else to it.
    const other = await ada.as("other").reply(root.id, "me too");
    const plain = await ada.reply(root.id, "thanks");
    await hook.saw(3);
    await hook.settle();
    expect(hook.attempts.map((attempt) => attempt.delivery.event.message?.id)).toEqual([
      root.id,
      other.id,
      plain.id,
    ]);
  });

  test("the filters of tail narrow what a watcher gets", async () => {
    const { handle, client: ada } = await vibe.join();
    const { handle: bobHandle, client: bob } = await vibe.join();
    const channel = vibe.channel();
    const thread = await ada.post(channel, "the thread to follow");
    const mentions = await watching(ada, { channel, mentions: bobHandle });
    const byBob = await watching(ada, { channel, by: bobHandle });
    const inThread = await watching(ada, { channel, re: thread.id });
    expect(mentions.watcher.tail.mentions).toStartWith("vibe:user:u_");

    const ping = await ada.post(channel, `@${bobHandle} have a look`);
    const answer = await bob.reply(thread.id, `@${handle} looking`);
    await mentions.hook.saw(1);
    await byBob.hook.saw(1);
    await inThread.hook.saw(1);
    for (const each of [mentions, byBob, inThread]) await each.hook.settle();

    const got = (each: typeof mentions) =>
      each.hook.attempts.map((attempt) => attempt.delivery.event.message?.id);
    expect(got(mentions)).toEqual([ping.id]);
    expect(got(byBob)).toEqual([answer.id]);
    expect(got(inThread)).toEqual([answer.id]);
  });

  test("a deleted watcher gets nothing more, and deleting takes it being yours, or manage at *", async () => {
    const by = await owner();
    const { client: ada } = await vibe.join();
    const { client: viewer } = await vibe.join("viewer");
    const channel = vibe.channel();
    const { hook, name, watcher } = await watching(ada, { channel });
    const second = await watching(ada, { channel });

    await ada.post(channel, "before");
    await hook.saw(1);
    expect(await failing(viewer.deleteWatcher(name))).toBe("forbidden");
    expect(await failing(viewer.deleteWatcher("no-such-watcher"))).toBe("watcher_not_found");

    expect((await ada.deleteWatcher(name)).id).toBe(watcher.id);
    // By its ID as well as its name, and by someone else who manages the vibe.
    expect((await by.deleteWatcher(second.watcher.id)).name).toBe(second.name);
    expect(await failing(ada.deleteWatcher(name))).toBe("watcher_not_found");
    expect((await ada.watchers()).some((each) => each.id === watcher.id)).toBe(false);

    await ada.post(channel, "after");
    await hook.settle();
    expect(hook.attempts).toHaveLength(1);
  });

  test("a watcher stops when whoever registered it is gone", async () => {
    const by = await owner();
    const serviceName = vibe.name("svc");
    const service = vibe.connect((await by.createService({ name: serviceName })).token);
    // A service registers watchers once a grant gives it manage at *.
    keep(
      await by.createGrant({
        principals: [{ kind: "service", name: serviceName }],
        can: { "*": "all" },
      }),
    );
    const channel = vibe.channel();
    const { hook, watcher } = await watching(service, { channel });
    expect(watcher.by.handle).toBe(serviceName);

    await by.post(channel, "while the service is here");
    await hook.saw(1);

    await by.deleteService(serviceName);
    await by.post(channel, "after it is gone");
    await hook.settle();
    await hook.settle();
    expect(hook.attempts).toHaveLength(1);
    expect((await by.watchers()).find((each) => each.id === watcher.id)).toMatchObject({
      state: "stopped",
      reason: "author_not_found",
    });
    await by.deleteWatcher(watcher.id);
  });
});
