import { DurableObject } from "cloudflare:workers";

/**
 * One per vibe, and it holds no data: only the sockets of clients that wait
 * for news of that vibe. After a commit the Worker tells it how far the vibe's
 * event log has got, and it passes that number to every socket. A client that
 * hears it asks `GET /events`, which decides what that client may read, so
 * the hub has nothing to leak: it never learns what happened, or to whom it
 * is talking.
 *
 * Sockets hibernate. Between pokes the object is evicted and the connections
 * stay open, so a client that waits for an hour costs nothing while it waits.
 */
export class VibeHub extends DurableObject {
  /** Accepts a socket. The Worker has already checked who is asking. */
  override fetch(_request: Request): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Tells every socket the place the vibe's log has got to. */
  poke(seq: number): void {
    const message = String(seq);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket that went away between the list and the send. Its client
        // asks again on its own.
      }
    }
  }

  /**
   * Clients have nothing to tell the hub, and each message would wake it. A
   * socket that speaks is closed; its client goes back to asking on its own.
   */
  override webSocketMessage(socket: WebSocket): void {
    try {
      socket.close(1008, "This socket only listens.");
    } catch {
      // Already closed.
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
