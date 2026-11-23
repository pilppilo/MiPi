/** Request bodies read with a size limit, for routes that run before any other check (Telegram, relay). */

/** The body, read up to `limit` bytes; undefined once it is larger, without reading the rest. */
export async function readBounded(
  request: Request,
  limit: number,
): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}
