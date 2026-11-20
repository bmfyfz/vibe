/**
 * Reads a request's body as text, and stops as soon as it has seen more than
 * `most` bytes. A body's size can't be taken from `Content-Length`: a sender
 * may leave it out and stream as much as it likes, and reading it all first
 * to measure it would be the harm the limit is there to prevent.
 *
 * @param tooMuch What to throw for a body over the limit, declared or found.
 */
export async function textUpTo(
  request: Request,
  most: number,
  tooMuch: () => Error,
): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > most) throw tooMuch();
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > most) {
      // Tells the sender to stop. Whether it does is its affair: nothing more is read.
      await reader.cancel().catch(() => {});
      throw tooMuch();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  // As `Request.text()` reads it: UTF-8, without a byte order mark.
  return new TextDecoder().decode(bytes);
}
