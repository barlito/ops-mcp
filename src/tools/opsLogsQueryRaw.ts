import { z } from "zod";
import { fetchEntries } from "../logs/fetch";
import { cleanLine } from "../logs/fingerprint";
import { DAY_MS } from "../logs/patterns";
import { isoNs, toNs } from "../logs/time";
import { clampWindow, defineTool, envelopeSchema, limitParam, resolveWindow, scopeShape } from "./contract";

const MAX_LOGQL_CHARS = 2000;
const MAX_SERIES = 20;
const MAX_POINTS = 60;

const ItemSchema = z.object({
  kind: z.enum(["line", "series"]),
  labels: z.record(z.string(), z.string()),
  ts: z.string().optional(),
  line: z.string().optional(),
  points: z.array(z.tuple([z.number(), z.string()])).optional(),
});
type Item = z.infer<typeof ItemSchema>;

const isLogQuery = (logql: string): boolean => logql.trimStart().startsWith("{");

export const opsLogsQueryRaw = defineTool({
  name: "ops_logs_query_raw",
  description: `Run a raw LogQL query. Log queries (starting with a stream selector) return redacted lines cut to 400 characters over a window capped at 24h; metric queries (rate, count_over_time, sum by...) return at most ${MAX_SERIES} series of ${MAX_POINTS} points over a window capped at 7d. Stream labels: server, deployment_environment, host_name, service_namespace (stack), service_name (full service name), container; detected_level is structured metadata (| detected_level="error"). Prefer ops_logs_summary and ops_logs_query when they fit.`,
  inputSchema: z.object({
    logql: z.string().min(1).max(MAX_LOGQL_CHARS).describe(`LogQL query, at most ${MAX_LOGQL_CHARS} characters.`),
    since: scopeShape.since,
    until: scopeShape.until,
    limit: limitParam(50, 200),
  }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (i: Item) => (i.kind === "line" ? `${i.ts} ${JSON.stringify(i.labels)}: ${i.line}` : `${JSON.stringify(i.labels)} ${JSON.stringify(i.points)}`),
  async handler(args, ctx) {
    const logQuery = isLogQuery(args.logql);
    const window = clampWindow(resolveWindow(args, ctx.now()), logQuery ? DAY_MS : 7 * DAY_MS);
    const note = window.clamped ? ` (window capped at ${logQuery ? "24h" : "7d"})` : "";
    const start = toNs(window.from);
    const end = toNs(window.to);

    if (logQuery) {
      const data = await ctx.loki.queryRange({ query: args.logql, start, end, limit: args.limit + 1, direction: "backward" });
      if (data.type !== "streams") return { summary: "no lines", items: [], window };
      const lines = data.streams.flatMap((s) => s.values.map(([ns, line]) => ({ ns, labels: s.labels, line }))).sort((a, b) => (a.ns === b.ns ? 0 : a.ns < b.ns ? 1 : -1));
      const items: Item[] = lines.slice(0, args.limit).map((l) => ({ kind: "line", labels: l.labels, ts: isoNs(l.ns), line: cleanLine(l.line) }));
      return { summary: `${items.length} line${items.length === 1 ? "" : "s"}${note}`, items, truncated: lines.length > args.limit, window };
    }

    const step = Math.max(1, Math.ceil((window.to.getTime() - window.from.getTime()) / 1000 / MAX_POINTS));
    const data = await ctx.loki.queryRange({ query: args.logql, start, end, step });
    if (data.type !== "series") return { summary: "the query returned log lines, not metrics", items: [], window };
    const items: Item[] = data.series.slice(0, MAX_SERIES).map((s) => ({ kind: "series", labels: s.labels, points: s.points.slice(-MAX_POINTS) }));
    return { summary: `${items.length} series, step ${step}s${note}`, items, truncated: data.series.length > MAX_SERIES, window };
  },
});
