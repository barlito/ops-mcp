import { redactAll } from "../platform/redact/secrets";
import { SlotLimiter } from "../platform/slotLimiter";
import { ToolError, type TimeWindow } from "../tools/contract";
import { backendJson } from "./http";

export interface PromSample {
  labels: Record<string, string>;
  value: number;
}

export interface PromSeries {
  labels: Record<string, string>;
  // [unix seconds, value], non-finite values dropped.
  points: Array<[number, number]>;
}

export interface PromAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: string;
  activeAt?: string;
  value?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  // Maximum number of series Prometheus returns.
  limit?: number;
}

export interface AlertSource {
  alerts(opts?: CallOptions): Promise<PromAlert[]>;
}

export interface PromApi extends AlertSource {
  // Whether Prometheus loads at least one rule group (cached briefly).
  hasRules(opts?: CallOptions): Promise<boolean>;
  query(promql: string, at: Date, opts?: CallOptions): Promise<PromSample[]>;
  queryRange(promql: string, window: TimeWindow, stepSeconds: number, opts?: CallOptions): Promise<PromSeries[]>;
}

interface PromBody {
  status?: string;
  errorType?: string;
  error?: string;
  data?: unknown;
}

const MAX_ERROR_CHARS = 300;
const RULES_TTL_MS = 30_000;
const finite = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const asLabels = (v: unknown): Record<string, string> => (v && typeof v === "object" ? (v as Record<string, string>) : {});

export class PromClient implements PromApi {
  private readonly limiter: SlotLimiter;
  private rules: { at: number; value: boolean } | undefined;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly baseUrl: string,
    private readonly config: { timeoutMs?: number; slots?: number } = {},
  ) {
    this.limiter = new SlotLimiter(config.slots ?? 4);
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? 10_000;
  }

  async query(promql: string, at: Date, opts?: CallOptions): Promise<PromSample[]> {
    const data = (await this.request("/api/v1/query", { query: promql, time: String(at.getTime() / 1000) }, opts)) as { result?: Array<{ metric?: unknown; value?: [number, string] }> };
    return (data.result ?? []).flatMap((r) => {
      const value = finite(r.value?.[1]);
      return value === undefined ? [] : [{ labels: asLabels(r.metric), value }];
    });
  }

  async queryRange(promql: string, window: TimeWindow, stepSeconds: number, opts?: CallOptions): Promise<PromSeries[]> {
    const data = (await this.request("/api/v1/query_range", {
      query: promql,
      start: String(window.from.getTime() / 1000),
      end: String(window.to.getTime() / 1000),
      step: String(stepSeconds),
    }, opts)) as { result?: Array<{ metric?: unknown; values?: Array<[number, string]> }> };
    return (data.result ?? []).map((r) => ({
      labels: asLabels(r.metric),
      points: (r.values ?? []).flatMap(([t, v]): Array<[number, number]> => {
        const n = finite(v);
        return n === undefined ? [] : [[t, n]];
      }),
    }));
  }

  async hasRules(opts?: CallOptions): Promise<boolean> {
    if (this.rules && Date.now() - this.rules.at < RULES_TTL_MS) return this.rules.value;
    const data = (await this.request("/api/v1/rules", undefined, opts)) as { groups?: unknown[] };
    this.rules = { at: Date.now(), value: (data.groups ?? []).length > 0 };
    return this.rules.value;
  }

  async alerts(opts?: CallOptions): Promise<PromAlert[]> {
    const data = (await this.request("/api/v1/alerts", undefined, opts)) as { alerts?: PromAlert[] };
    return data.alerts ?? [];
  }

  private wrap(release: () => void): () => void {
    return () => {
      release();
      this.waiting.shift()?.();
    };
  }

  // Waits for a free slot, at most the request timeout, and leaves the queue when the caller aborts.
  private slot(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new ToolError("cancelled", "Request cancelled."));
    const free = this.limiter.acquire([]);
    if (free) return Promise.resolve(this.wrap(free));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const leave = (err: ToolError) => {
        const i = this.waiting.indexOf(waiter);
        if (i >= 0) this.waiting.splice(i, 1);
        cleanup();
        reject(err);
      };
      const onAbort = () => leave(new ToolError("cancelled", "Request cancelled."));
      const timer = setTimeout(() => leave(new ToolError("backend_timeout", `Prometheus is busy: no free query slot within ${this.timeoutMs} ms.`)), this.timeoutMs);
      const waiter = () => {
        cleanup();
        resolve(this.wrap(this.limiter.acquire([])!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private async request(path: string, form: Record<string, string> | undefined, opts: CallOptions | undefined): Promise<unknown> {
    const release = await this.slot(opts?.signal);
    try {
      const params = form && { ...form, ...(opts?.limit ? { limit: String(opts.limit) } : {}), timeout: `${Math.max(1, Math.floor(this.timeoutMs / 1000) - 1)}s` };
      const { status, body } = await backendJson("Prometheus", `${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: params ? "POST" : "GET",
        headers: params ? { "content-type": "application/x-www-form-urlencoded" } : undefined,
        body: params && new URLSearchParams(params).toString(),
        timeoutMs: this.timeoutMs,
        signal: opts?.signal,
      });
      const b = body as PromBody | undefined;
      if (status === 200 && b?.status === "success") return b.data ?? {};
      const detail = redactAll(b?.error ?? "").slice(0, MAX_ERROR_CHARS);
      if (b?.errorType === "timeout") throw new ToolError("backend_timeout", `Prometheus query timed out: ${detail}`);
      if (status === 400 || status === 422) throw new ToolError("query_rejected", `Prometheus rejected the query: ${detail}`);
      throw new ToolError("backend_unavailable", `Prometheus answered HTTP ${status}${detail ? `: ${detail}` : ""}.`);
    } finally {
      release();
    }
  }
}
