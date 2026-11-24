import { ToolError } from "../tools/contract";
import type { LogEntry } from "./fingerprint";
import type { LokiApi, LokiData, LokiStream } from "./LokiClient";

// Loki caps max_entries_limit_per_query at 1000.
export const PAGE_LINES = 1000;
export const SAMPLE_LINES = 5000;

function streamsOf(data: LokiData): LokiStream[] {
  if (data.type !== "streams") throw new ToolError("query_rejected", "The query returned metrics, not log lines.");
  return data.streams;
}

export function toEntries(streams: LokiStream[]): LogEntry[] {
  return streams.flatMap((s) =>
    s.values.map(([ns, line]) => ({ ns, server: s.labels.server ?? "?", service: s.labels.service_name ?? "?", level: s.labels.detected_level ?? "unknown", line })),
  );
}

export async function fetchEntries(
  loki: LokiApi,
  p: { query: string; start: bigint; end: bigint; limit: number; direction: "forward" | "backward" },
): Promise<LogEntry[]> {
  const entries = toEntries(streamsOf(await loki.queryRange(p)));
  const sign = p.direction === "backward" ? -1 : 1;
  entries.sort((a, b) => (a.ns === b.ns ? 0 : a.ns < b.ns ? -sign : sign));
  return entries.slice(0, p.limit);
}

// Newest first, paging backwards in time until `max` lines or the window is exhausted.
export async function sampleEntries(loki: LokiApi, query: string, start: bigint, end: bigint, max = SAMPLE_LINES): Promise<LogEntry[]> {
  const out: LogEntry[] = [];
  let cursorEnd = end;
  while (out.length < max) {
    const want = Math.min(PAGE_LINES, max - out.length);
    const page = await fetchEntries(loki, { query, start, end: cursorEnd, limit: want, direction: "backward" });
    out.push(...page);
    if (page.length < want) break;
    cursorEnd = page[page.length - 1]!.ns;
  }
  return out;
}
