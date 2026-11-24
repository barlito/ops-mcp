import { z } from "zod";
import { type LokiApi } from "../logs/LokiClient";
import { DAY_MS, levelPatterns, topPatterns } from "../logs/patterns";
import { LEVELS, levelFilter, levelsFrom, logQuery, selector } from "../logs/selector";
import { isoNs, toNs } from "../logs/time";
import { clampWindow, defineTool, envelopeSchema, type ScopeParams, resolveServers, resolveWindow, scopeShape } from "./contract";

const WEEK_MS = 7 * DAY_MS;
const MAX_COUNT_ROWS = 20;

const ItemSchema = z.object({
  kind: z.enum(["count", "pattern"]),
  server: z.string(),
  service: z.string(),
  level: z.string(),
  count: z.number(),
  pattern: z.string().optional(),
  first_seen: z.string().optional(),
  last_seen: z.string().optional(),
  example: z.string().optional(),
});
type Item = z.infer<typeof ItemSchema>;

async function countRows(loki: LokiApi, scope: ScopeParams, levels: ReturnType<typeof levelsFrom>, from: Date, to: Date): Promise<Item[]> {
  const seconds = Math.ceil((to.getTime() - from.getTime()) / 1000);
  const inner = logQuery(selector(scope), levelFilter(levels));
  const data = await loki.query({ query: `sum by (server, service_name, detected_level) (count_over_time(${inner} [${seconds}s]))`, time: toNs(to) });
  if (data.type !== "series") return [];
  return data.series
    .map((s) => ({ kind: "count" as const, server: s.labels.server ?? "?", service: s.labels.service_name ?? "?", level: s.labels.detected_level ?? "unknown", count: Math.round(Number(s.points[0]?.[1] ?? 0)) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
}

export const opsLogsSummary = defineTool({
  name: "ops_logs_summary",
  description:
    "Start here for log triage: line counts per service and level at or above level_min, plus the top recurring error patterns (ids, numbers and addresses normalised) with first/last seen and one redacted example. Counts cover the window (capped at 7d), patterns the last 24h of it.",
  inputSchema: z.object({
    ...scopeShape,
    level_min: z.enum(LEVELS).default("warn").describe("Lowest level counted (default warn)."),
    top: z.number().int().min(1).max(20).default(5).describe("Number of patterns returned (default 5, max 20)."),
  }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (i: Item) =>
    i.kind === "count"
      ? `${i.server} ${i.service} ${i.level} x${i.count}`
      : `PATTERN ${i.server} ${i.service} ${i.level} x${i.count} ${i.first_seen}..${i.last_seen} ${i.pattern} | e.g. ${i.example}`,
  async handler(args, ctx) {
    resolveServers(ctx.registry, args.server);
    const window = clampWindow(resolveWindow(args, ctx.now()), WEEK_MS);
    const sampleWindow = clampWindow(window, DAY_MS);
    const levels = levelsFrom(args.level_min);
    const [counts, groups] = await Promise.all([countRows(ctx.loki, args, levels, window.from, window.to), levelPatterns(ctx.loki, args, args.level_min, sampleWindow)]);

    const patterns: Item[] = topPatterns(groups, args.top).map((g) => ({
      kind: "pattern",
      server: g.server,
      service: g.service,
      level: g.level,
      count: g.count,
      pattern: g.pattern,
      first_seen: isoNs(g.first),
      last_seen: isoNs(g.last),
      example: g.example,
    }));
    const total = counts.reduce((n, r) => n + r.count, 0);
    const services = new Set(counts.map((r) => `${r.server}/${r.service}`)).size;
    const notes = [window.clamped ? "window capped at 7d" : "", sampleWindow.clamped ? "patterns from the last 24h" : ""].filter(Boolean);
    return {
      summary: `${total} line${total === 1 ? "" : "s"} at ${args.level_min}+ across ${services} service${services === 1 ? "" : "s"}, ${patterns.length} pattern${patterns.length === 1 ? "" : "s"}${notes.length ? ` (${notes.join(", ")})` : ""}`,
      items: [...patterns, ...counts.slice(0, MAX_COUNT_ROWS)],
      truncated: counts.length > MAX_COUNT_ROWS,
      window,
    };
  },
});
