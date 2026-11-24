import { z } from "zod";
import { SlotLimiter } from "../platform/slotLimiter";
import { redactAll } from "../platform/redact/secrets";
import { ToolError } from "../tools/contract";

const DEFAULT_URL = "http://loki:3100";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_ERROR_CHARS = 300;
const QUEUE_WAIT_MS = 5000;
const QUEUE_POLL_MS = 25;

export interface LokiStream {
  labels: Record<string, string>;
  values: Array<[ns: bigint, line: string]>;
}

export interface LokiSeries {
  labels: Record<string, string>;
  points: Array<[ts: number, value: string]>;
}

export type LokiData = { type: "streams"; streams: LokiStream[] } | { type: "series"; series: LokiSeries[] };

export interface RangeParams {
  query: string;
  start: bigint;
  end: bigint;
  limit?: number;
  direction?: "forward" | "backward";
  // Seconds between two points of a metric query.
  step?: number;
}

export interface InstantParams {
  query: string;
  time: bigint;
}

export interface CallOptions {
  // Aborting stops the Loki request (client went away).
  signal?: AbortSignal;
}

export interface LokiApi {
  queryRange(params: RangeParams, opts?: CallOptions): Promise<LokiData>;
  query(params: InstantParams, opts?: CallOptions): Promise<LokiData>;
}

// The same client with every call tied to one abort signal (the tool call's).
export const withSignal = (loki: LokiApi, signal: AbortSignal): LokiApi => ({
  queryRange: (p, opts) => loki.queryRange(p, { signal, ...opts }),
  query: (p, opts) => loki.query(p, { signal, ...opts }),
});

// At most `max` concurrent requests of this wrapper, the others wait; leaves slots to the other tools.
export function withConcurrency(loki: LokiApi, max: number): LokiApi {
  let active = 0;
  const waiting: Array<() => void> = [];
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  return { queryRange: (p, opts) => run(() => loki.queryRange(p, opts)), query: (p, opts) => run(() => loki.query(p, opts)) };
}

const labelsSchema = z.record(z.string(), z.string());
const responseSchema = z.object({
  status: z.literal("success"),
  data: z.discriminatedUnion("resultType", [
    z.object({ resultType: z.literal("streams"), result: z.array(z.object({ stream: labelsSchema, values: z.array(z.tuple([z.string(), z.string()]).rest(z.unknown())) })) }),
    z.object({ resultType: z.literal("matrix"), result: z.array(z.object({ metric: labelsSchema, values: z.array(z.tuple([z.number(), z.string()])) })) }),
    z.object({ resultType: z.literal("vector"), result: z.array(z.object({ metric: labelsSchema, value: z.tuple([z.number(), z.string()]) })) }),
  ]),
});

export class LokiClient implements LokiApi {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly limiter: SlotLimiter;
  private readonly queueWaitMs: number;

  constructor(opts: { url?: string; timeoutMs?: number; concurrency?: number; queueWaitMs?: number } = {}) {
    this.queueWaitMs = opts.queueWaitMs ?? QUEUE_WAIT_MS;
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.limiter = new SlotLimiter(opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  queryRange(p: RangeParams, opts?: CallOptions): Promise<LokiData> {
    const q = new URLSearchParams({ query: p.query, start: String(p.start), end: String(p.end), direction: p.direction ?? "backward" });
    if (p.limit !== undefined) q.set("limit", String(p.limit));
    if (p.step !== undefined) q.set("step", `${p.step}s`);
    return this.get("/loki/api/v1/query_range", q, opts?.signal);
  }

  query(p: InstantParams, opts?: CallOptions): Promise<LokiData> {
    return this.get("/loki/api/v1/query", new URLSearchParams({ query: p.query, time: String(p.time) }), opts?.signal);
  }

  // Waits a few seconds for a free slot instead of failing at once.
  private async acquire(signal?: AbortSignal): Promise<() => void> {
    const deadline = Date.now() + this.queueWaitMs;
    for (;;) {
      if (signal?.aborted) throw new ToolError("cancelled", "The request was cancelled.");
      const release = this.limiter.acquire([]);
      if (release) return release;
      if (Date.now() >= deadline) throw new ToolError("backend_busy", "Too many concurrent Loki queries, retry shortly.");
      await new Promise((r) => setTimeout(r, QUEUE_POLL_MS));
    }
  }

  private async get(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<LokiData> {
    const release = await this.acquire(signal);
    try {
      const request = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
      let res: Response;
      let body: string;
      try {
        res = await fetch(`${this.url}${path}?${params}`, { signal: request });
        body = await res.text();
      } catch (err) {
        if (signal?.aborted) throw new ToolError("cancelled", "The request was cancelled.");
        if (err instanceof Error && err.name === "TimeoutError") throw new ToolError("backend_timeout", `Loki did not answer within ${this.timeoutMs / 1000}s.`);
        throw new ToolError("backend_unavailable", "Loki is unreachable.");
      }
      if (res.status === 400 || res.status === 422) throw new ToolError("query_rejected", `Loki rejected the query: ${clean(body)}`);
      if (res.status === 504) throw new ToolError("backend_timeout", "Loki query timed out.");
      if (!res.ok) throw new ToolError("backend_unavailable", `Loki answered HTTP ${res.status}.`);
      return parse(body);
    } finally {
      release();
    }
  }
}

const clean = (text: string): string => redactAll(text).slice(0, MAX_ERROR_CHARS).trim();

function parse(body: string): LokiData {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new ToolError("backend_unavailable", "Loki returned a non-JSON answer.");
  }
  const r = responseSchema.safeParse(json);
  if (!r.success) throw new ToolError("backend_unavailable", "Loki returned an unexpected answer.");
  const data = r.data.data;
  switch (data.resultType) {
    case "streams":
      return { type: "streams", streams: data.result.map((s) => ({ labels: s.stream, values: s.values.map(([ns, line]) => [BigInt(ns), line]) })) };
    case "matrix":
      return { type: "series", series: data.result.map((s) => ({ labels: s.metric, points: s.values })) };
    case "vector":
      return { type: "series", series: data.result.map((s) => ({ labels: s.metric, points: [s.value] })) };
  }
}
