import { createVibe, type LiveHub } from "@vibe/server";
import { createDb } from "@vibe/store";
import { d1Executor } from "@vibe/store/d1";
import { r2BlobStore } from "@vibe/store/r2";
import { env, exports, waitUntil } from "cloudflare:workers";
import { CloudflareAdapter } from "elysia/adapter/cloudflare-worker";

export { VibeHub } from "./hub.ts";

/**
 * The hub of one vibe. Every caller that names the same vibe reaches the same
 * object. `exports` is this Worker's own: the class is declared in
 * cloudflare.config.ts, and needs no binding to be reached from here.
 */
const hubOf = (vibeId: string) => exports.VibeHub.get(exports.VibeHub.idFromName(vibeId));

const hub: LiveHub = {
  connect: (vibeId, request) => hubOf(vibeId).fetch(request),
  // After the response, not before it: a write never waits for its poke, and
  // a poke that fails costs a waiting client one re-poll, nothing more.
  poke(vibeId, seq) {
    const poked = hubOf(vibeId)
      .poke(seq)
      .catch((error: unknown) => console.error(`Poking the hub of ${vibeId} failed.`, error));
    waitUntil(poked);
  },
};

// With hub.ts, the only files that know they run on Cloudflare: they hand D1,
// R2, a Durable Object and a queue to an app that sees a database, a blob
// store, a hub, and something that runs a delivery pass later.
const vibe = createVibe({
  db: createDb(d1Executor(env.DB)),
  blobs: r2BlobStore(env.FILES),
  hub,
  adapter: CloudflareAdapter,
  adminSecret: env.VIBE_ADMIN_SECRET,
  // Both are empty where the deployment set neither: see cloudflare.config.ts.
  github: env.VIBE_GITHUB_CLIENT_ID
    ? { clientId: env.VIBE_GITHUB_CLIENT_ID, allowSignup: env.VIBE_GITHUB_SIGNUP === "true" }
    : undefined,
  background: waitUntil,
  // The address Cloudflare took the request from. Cloudflare sets the header
  // itself and overwrites one a client sends, so it can't be chosen.
  clientAddress: (request) => request.headers.get("cf-connecting-ip"),
  deliveries: {
    // The queue only says which vibe to look at, and when. A message that
    // goes missing delays a delivery until the next minute's pass. It can't
    // lose one: what a watcher is owed is in its cursor.
    request(vibeId, delayMs) {
      const sent = env.DELIVERIES.send(
        { vibeId },
        { delaySeconds: Math.ceil(delayMs / 1000) },
      ).catch((error: unknown) =>
        console.error(`Asking for a delivery pass on ${vibeId} failed.`, error),
      );
      waitUntil(sent);
    },
  },
});

// `vibe.fetch` runs `app.fetch` and not `app.compile()`: compiling generates
// code from strings. See the note on `aot` in the app.
export default {
  fetch: (request) => vibe.fetch(request),

  // Each minute: post the schedules that are due, record the leases that
  // lapsed and ready the tasks that have nothing left to wait for, and deliver
  // to the watchers that are behind. None of them holds the others up, and
  // nothing is correct only because this ran.
  scheduled: (_controller, _env, context) => {
    context.waitUntil(vibe.tick());
  },

  // A delivery pass for each vibe the batch names, once. A pass that throws
  // is logged and its messages are still acknowledged: the watcher's cursor
  // didn't move, so the next minute's pass delivers what this one didn't.
  queue: async (batch) => {
    for (const vibeId of new Set(batch.messages.map((message) => message.body.vibeId))) {
      try {
        await vibe.deliverVibe(vibeId);
      } catch (error) {
        console.error(`A delivery pass on ${vibeId} failed.`, error);
      }
    }
    batch.ackAll();
  },
} satisfies ExportedHandler<Env, { vibeId: string }>;
