import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createDb } from "@vibe/store";
import { bunSqliteExecutor, openDatabase } from "@vibe/store/bun-sqlite";
import { fsBlobStore } from "@vibe/store/fs";

import { createVibe, type LiveHub } from "./app.ts";
import { webSite } from "./web.ts";

export interface ServeOptions {
  /** The directory that holds the database and the files. It is created when missing. */
  dir: string;
  /** The port to listen on. 0 takes any free one. */
  port: number;
  /** The address to listen on. This machine only, unless said otherwise. */
  hostname?: string | undefined;
  /** The operator's secret for `/v1/admin`. */
  adminSecret: string;
  /** How often the scheduler's pass runs, in milliseconds. A minute, as on a Worker. */
  tickMs?: number | undefined;
  /** The GitHub OAuth app people sign in through, when there is one. */
  github?: { clientId: string; allowSignup?: boolean | undefined } | undefined;
  /** The directory the web app was built into. Left out, or without a built app in it, only the API is served. */
  web?: string | undefined;
  /**
   * The header a proxy in front of this server puts the client's address in,
   * such as `x-forwarded-for`. Name one only when every request comes through
   * that proxy, and it sets the header itself: the address is what the
   * limits on guessing a credential are counted against, so a header the
   * sender can write lets it be anyone. Left out, the address is the
   * connection's, which behind a proxy is the proxy's for everyone.
   *
   * A connection from this machine itself is never counted, header or not:
   * whoever is on the machine can read the Vibe's own files, and a proxy on
   * it would otherwise make every caller one, for any of them to lock out.
   */
  addressHeader?: string | undefined;
  /**
   * Where people reach this Vibe, when that is not where it listens: the
   * `https://vibe.example.com` a proxy in front of it ends TLS for. Requests
   * are then read as made to that origin, which is what lets a browser sign
   * in: the session's cookie is `Secure`, and a page's request is checked to
   * come from that origin and not from `http://127.0.0.1`.
   */
  publicUrl?: string | undefined;
}

/** What a header's name may be made of. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

/** The origin of the address people reach a Vibe at. It is an address, not a page: no path. */
function originOf(publicUrl: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new TypeError(`"${publicUrl}" is not a URL.`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/") {
    throw new TypeError(`"${publicUrl}" should be an origin, such as https://vibe.example.com.`);
  }
  return url.origin;
}

/** Whether an address is this machine's own: `127.0.0.0/8` or `::1`, however it is written. */
function isLoopback(address: string): boolean {
  const plain = address.toLowerCase().replace(/^::ffff:/, "");
  return plain === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

export interface ServedVibe {
  /** Where it answers, such as `http://127.0.0.1:7473`. */
  url: string;
  port: number;
  /** Whether it serves the web app beside the API. */
  web: boolean;
  /** Stops listening, stops the timers and closes the database. */
  stop(): Promise<void>;
}

/** What a live socket remembers: the vibe whose pokes it hears. */
interface Listener {
  vibeId: string;
}

// A request that waits for events may take 20 seconds to answer. Bun closes a
// connection that says nothing for 10 unless told otherwise.
const IDLE_TIMEOUT_SECONDS = 120;

/**
 * Serves Vibe on Bun: the same app a Worker serves, on SQLite in a file and
 * attachments in a directory. Where a Worker has a Durable Object, a queue and
 * a cron trigger, this has Bun's own WebSockets and timers:
 *
 * - live sockets subscribe to their vibe, and a commit publishes to it;
 * - a write to a vibe with watchers runs a delivery pass a moment later;
 * - each minute, one pass of due schedules, the task sweep and late deliveries.
 *
 * The web app's files are served from the same origin as the API, as they
 * are from a Worker: everything under `/v1` is the API, and the rest is the app.
 */
export function serveVibe(options: ServeOptions): ServedVibe {
  const { addressHeader } = options;
  if (addressHeader !== undefined && !HEADER_NAME.test(addressHeader)) {
    throw new TypeError(`"${addressHeader}" is not the name of a header.`);
  }
  const publicOrigin = options.publicUrl === undefined ? null : originOf(options.publicUrl);
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  const database = openDatabase(join(options.dir, "vibe.db"));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let stopped = false;

  /** Runs work that nothing waits for. Whatever it throws is logged, and the server carries on. */
  const later = (what: string, delayMs: number, work: () => Promise<unknown>) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      work().catch((error: unknown) => console.error(`${what} failed.`, error));
    }, delayMs);
    timers.add(timer);
  };

  // The responses that stand for a socket Bun has already opened. Bun upgrades
  // a request in place and wants nothing returned for it.
  const upgraded = new WeakSet<Response>();
  // A request read as made to the public origin is a new object. Bun
  // upgrades, and knows the address of, the one that arrived.
  const arrived = new WeakMap<Request, Request>();
  const asArrived = (request: Request) => arrived.get(request) ?? request;
  const hub: LiveHub = {
    async connect(vibeId, request) {
      if (!server.upgrade(asArrived(request), { data: { vibeId } })) {
        return Response.json(
          {
            code: "invalid_request",
            message: "This request could not be upgraded to a WebSocket.",
          },
          { status: 400 },
        );
      }
      const response = new Response(null);
      upgraded.add(response);
      return response;
    },
    poke(vibeId, seq) {
      server.publish(vibeId, String(seq));
    },
  };

  const vibe = createVibe({
    db: createDb(bunSqliteExecutor(database)),
    blobs: fsBlobStore(join(options.dir, "blobs")),
    hub,
    adminSecret: options.adminSecret,
    github: options.github,
    clientAddress(request) {
      // A proxy adds the address it saw to the end of what the client sent.
      const named =
        addressHeader === undefined
          ? undefined
          : request.headers.get(addressHeader)?.split(",").at(-1);
      if (named?.trim()) return named;
      // No header: the connection's own address, unless it is this machine's.
      const direct = server.requestIP(asArrived(request))?.address;
      return direct === undefined || isLoopback(direct) ? null : direct;
    },
    deliveries: {
      request(vibeId, delayMs) {
        later(`A delivery pass on ${vibeId}`, delayMs, () => vibe.deliverVibe(vibeId));
      },
    },
  });

  const site = options.web === undefined ? null : webSite(options.web);
  const isApi = (request: Request) => {
    const { pathname } = new URL(request.url);
    return pathname === "/v1" || pathname.startsWith("/v1/");
  };

  const server = Bun.serve<Listener>({
    port: options.port,
    hostname: options.hostname ?? "127.0.0.1",
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      const page = site !== null && !isApi(request) ? site(request) : null;
      if (page) return page;
      let seen = request;
      if (publicOrigin !== null) {
        const { pathname, search } = new URL(request.url);
        seen = new Request(`${publicOrigin}${pathname}${search}`, request);
        arrived.set(seen, request);
      }
      const response = await vibe.fetch(seen);
      return upgraded.has(response) ? undefined : response;
    },
    websocket: {
      open(socket) {
        socket.subscribe(socket.data.vibeId);
      },
      // The socket says how far the log has got, and hears nothing. One that
      // speaks is closed, as the Worker's hub closes it.
      message(socket) {
        socket.close(1008, "This socket only listens.");
      },
    },
  });

  const tickMs = options.tickMs ?? 60_000;
  const tick = setInterval(() => {
    vibe.tick().catch((error: unknown) => console.error("The scheduler's pass failed.", error));
  }, tickMs);

  return {
    // An IPv6 address goes in brackets in a URL.
    url: `http://${server.hostname?.includes(":") ? `[${server.hostname}]` : server.hostname}:${server.port}`,
    port: server.port ?? options.port,
    web: site !== null,
    async stop() {
      stopped = true;
      clearInterval(tick);
      for (const timer of timers) clearTimeout(timer);
      await server.stop(true);
      database.close();
    },
  };
}
