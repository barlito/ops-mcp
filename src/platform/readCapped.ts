export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`response body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

// Reads a response body as UTF-8 text, aborting the transfer as soon as it exceeds `maxBytes`.
export async function readCapped(res: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new BodyTooLargeError(maxBytes);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  return Buffer.concat(chunks).toString("utf8");
}
