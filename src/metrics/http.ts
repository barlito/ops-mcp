import { ToolError } from "../tools/contract";
import { redactAll } from "../platform/redact/secrets";
import { errorMessage } from "../platform/util";

export interface BackendRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

// JSON over HTTP with failures mapped to ToolError; `body` is undefined when the answer is not JSON.
export async function backendJson(backend: string, url: string, req: BackendRequest): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body, signal: req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]) : AbortSignal.timeout(req.timeoutMs) });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ToolError("backend_timeout", `${backend} did not answer within ${req.timeoutMs} ms.`);
    }
    const cause = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code : undefined;
    throw new ToolError("backend_unavailable", `${backend} is unreachable: ${redactAll(errorMessage(err))}${cause ? ` (${cause})` : ""}.`);
  }
}
