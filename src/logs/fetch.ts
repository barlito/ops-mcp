import { ToolError } from "../tools/contract";
import type { LogEntry } from "./fingerprint";
import type { LokiApi, LokiData, LokiStream } from "./LokiClient";

// Loki caps max_entries_limit_per_query at 1000.
export const PAGE_LINES = 1000;
export const SAMPLE_LINES = 5000;
// Wall-clock budget of a whole paged sample: the pages fetched so far are used when it runs out.
export const SAMPLE_BUDGET_MS = 20_000;

function streamsOf(data: LokiData): LokiStream[] {
  if (data.type !== "streams") throw new ToolError("query_rejected", "The query returned metrics, not log lines.");
  return data.streams;
}

export function toEntries(streams: LokiStream[]): LogEntry[] {
  return streams.flatMap((s) =>
    s.values.map(([ns, line]) => ({ ns, server: s.labels.server ?? "?", service: s.labels.service_name ?? "?", level: s.labels.detected_level ?? "unknown", line })),
  );
}

// Equal timestamps are ordered by service then line so a cursor can skip them reproducibly.
export function sortEntries(entries: LogEntry[], direction: "forward" | "backward"): LogEntry[] {
  const sign = direction === "backward" ? -1 : 1;
  const cmp = (a: LogEntry, b: LogEntry): number => (a.ns !== b.ns ? (a.ns < b.ns ? -1 : 1) : a.service !== b.service ? (a.service < b.service ? -1 : 1) : a.line < b.line ? -1 : a.line > b.line ? 1 : 0);
  return entries.sort((a, b) => sign * cmp(a, b));
}

export async function fetchEntries(
  loki: LokiApi,
  p: { query: string; start: bigint; end: bigint; limit: number; direction: "forward" | "backward" },
): Promise<LogEntry[]> {
  const entries = toEntries(streamsOf(await loki.queryRange(p)));
  return sortEntries(entries, p.direction).slice(0, p.limit);
}

// Newest first, paging backwards in time until `max` lines or the window is exhausted.
export async function sampleEntries(loki: LokiApi, query: string, start: bigint, end: bigint, max = SAMPLE_LINES, budgetMs = SAMPLE_BUDGET_MS): Promise<LogEntry[]> {
  const deadline = Date.now() + budgetMs;
  const out: LogEntry[] = [];
  let cursorEnd = end;
  while (out.length < max) {
    const want = Math.min(PAGE_LINES, max - out.length);
    const page = await fetchEntries(loki, { query, start, end: cursorEnd, limit: want, direction: "backward" });
    out.push(...page);
    if (page.length < want || Date.now() >= deadline) break;
    cursorEnd = page[page.length - 1]!.ns;
  }
  return out;
}
