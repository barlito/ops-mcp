import { redactAll } from "../platform/redact/secrets";
import { errorMessage } from "../platform/util";
import { ToolError } from "../tools/contract";

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface BackendRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

const TOO_LARGE = "result too large, narrow the query (by/topk)";

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  if (Number(res.headers.get("content-length")) > maxBytes) {
    await reader.cancel();
    throw new ToolError("query_rejected", TOO_LARGE);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ToolError("query_rejected", TOO_LARGE);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// JSON over HTTP with failures mapped to ToolError; `body` is undefined when the answer is not JSON.
export async function backendJson(backend: string, url: string, req: BackendRequest): Promise<{ status: number; body: unknown; headers: Headers }> {
  const timeout = AbortSignal.timeout(req.timeoutMs);
  try {
    const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout });
    const text = await readCapped(res, req.maxBytes ?? MAX_RESPONSE_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body, headers: res.headers };
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (req.signal?.aborted) throw new ToolError("cancelled", "Request cancelled.");
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ToolError("backend_timeout", `${backend} did not answer within ${req.timeoutMs} ms.`);
    }
    const cause = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code : undefined;
    throw new ToolError("backend_unavailable", `${backend} is unreachable: ${redactAll(errorMessage(err))}${cause ? ` (${cause})` : ""}.`);
  }
}
