/** As much of a WebSocket as listening for pokes takes. The standard one fits. */
export interface LiveSocket {
  addEventListener(type: "open" | "message" | "close" | "error", listener: () => void): void;
  close(): void;
}

/** Opens a socket to a `ws:` or `wss:` URL, sending the headers that say who is asking. */
export type OpenSocket = (url: string, headers: Record<string, string>) => LiveSocket;

/** How a handle listens for news of its vibe. */
export interface LiveSource {
  open: OpenSocket;
  /** How long to go without a poke before asking anyway, in case one was missed. */
  repollMs: number;
}

/** How long a socket gets to open before the handle goes on without it. */
const CONNECT_MS = 5000;
/** How long to wait before trying again a socket that failed or closed. */
const RETRY_MS = 60_000;

/**
 * The runtime's own WebSocket. Bun's and Node's send headers with the
 * handshake, which is how a token gets there. A browser's can't, and needs
 * none: it sends the session's cookie by itself. `null` where there is no
 * WebSocket at all.
 */
export function defaultSocket(): OpenSocket | null {
  const runtime = globalThis as { WebSocket?: unknown; document?: unknown };
  if (runtime.WebSocket === undefined) return null;
  if (runtime.document !== undefined) {
    // In a browser the second argument is a list of subprotocols, not options.
    const Socket = runtime.WebSocket as new (url: string) => LiveSocket;
    return (url) => new Socket(url);
  }
  const Socket = runtime.WebSocket as new (
    url: string,
    options: { headers: Record<string, string> },
  ) => LiveSocket;
  return (url, headers) => new Socket(url, { headers });
}

/**
 * Listens on a vibe's live socket for pokes. A poke says the vibe's event log
 * has moved, and nothing about what happened: whoever hears one asks for the
 * events, and is shown the ones it may read.
 *
 * Used as: `listen()`, ask for events, and when there were none, `heard()`. A
 * poke that arrives while asking is kept, so nothing falls between the two.
 */
export class Live {
  private socket: LiveSocket | null = null;
  private state: "idle" | "connecting" | "open" = "idle";
  private poked = false;
  private triedAt = Number.NEGATIVE_INFINITY;
  private waiters = new Set<() => void>();

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly source: LiveSource,
  ) {}

  /** How long to go without a poke before asking anyway. */
  get repollMs(): number {
    return this.source.repollMs;
  }

  /**
   * Whether the socket is open, opening it first when it isn't. A socket that
   * can't be opened is left alone for a while, so a Vibe without live
   * connections costs one attempt a minute and no more.
   */
  async ready(signal?: AbortSignal): Promise<boolean> {
    if (this.isOpen()) return true;
    if (signal?.aborted || Date.now() - this.triedAt < RETRY_MS) return false;
    this.triedAt = Date.now();
    this.state = "connecting";

    let socket: LiveSocket;
    try {
      socket = this.source.open(this.url, this.headers);
    } catch {
      this.state = "idle";
      return false;
    }
    this.socket = socket;
    const mine = () => this.socket === socket;
    socket.addEventListener("open", () => {
      if (!mine()) return;
      this.state = "open";
      this.wake();
    });
    socket.addEventListener("message", () => {
      if (!mine()) return;
      this.poked = true;
      this.wake();
    });
    const gone = () => {
      if (!mine()) return;
      this.socket = null;
      this.state = "idle";
      this.wake();
    };
    socket.addEventListener("close", gone);
    socket.addEventListener("error", gone);

    await this.settled(CONNECT_MS, signal);
    if (this.isOpen()) return true;
    this.close();
    return false;
  }

  private isOpen(): boolean {
    return this.state === "open";
  }

  /** Forgets the pokes heard so far. Call it before asking for events. */
  listen(): void {
    this.poked = false;
  }

  /**
   * Resolves once there is reason to ask again: a poke since `listen`, the
   * socket gone, `ms` passed, or the signal aborted.
   */
  async heard(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.poked || !this.isOpen()) return;
    await this.settled(ms, signal);
  }

  close(): void {
    const { socket } = this;
    this.socket = null;
    this.state = "idle";
    try {
      socket?.close();
    } catch {
      // Closing a socket that never opened may throw. It is gone either way.
    }
    this.wake();
  }

  /** Waits for the next thing that happens on the socket, for at most `ms`. */
  private settled(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
