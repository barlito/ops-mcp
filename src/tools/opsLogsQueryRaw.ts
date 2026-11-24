import { z } from "zod";
import { withSignal } from "../logs/LokiClient";
import { fetchEntries } from "../logs/fetch";
import { cleanLine } from "../logs/fingerprint";
import { analyzeLogql } from "../logs/logql";
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

const STREAM_LABELS = ["server", "deployment_environment", "host_name", "service_namespace", "service_name", "container", "detected_level"];
const SENSITIVE_KEY = /pass|pwd|secret|token|key|auth|cookie|session|credential/i;
const LABEL_CHARS = 200;

// Log streams expose only the known labels (parsers such as | json would otherwise surface any field).
const knownLabels = (labels: Record<string, string>): Record<string, string> =>
  Object.fromEntries(STREAM_LABELS.filter((k) => labels[k] !== undefined).map((k) => [k, cleanLine(labels[k]!, LABEL_CHARS)]));

const metricLabels = (labels: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(labels).map(([k, v]) => [k.slice(0, LABEL_CHARS), SENSITIVE_KEY.test(k) ? "[REDACTED]" : cleanLine(v, LABEL_CHARS)]));

export const opsLogsQueryRaw = defineTool({
  name: "ops_logs_query_raw",
  description: `Run a raw LogQL query. Log queries (starting with a stream selector) return redacted lines cut to 400 characters over a window capped at 24h; metric queries (rate, count_over_time, sum by...) return at most ${MAX_SERIES} series of ${MAX_POINTS} points over a window capped at 7d. Stream labels: server, deployment_environment, host_name, service_namespace (stack), service_name (full service name), container; detected_level is structured metadata (| detected_level="error"). Log queries return only the known stream labels; metric series labels are masked when their name looks sensitive. Redaction on raw queries is best-effort: line_format, label_format and ranges or offsets above 7d are refused. Prefer ops_logs_summary and ops_logs_query when they fit.`,
  inputSchema: z.object({
    logql: z.string().min(1).max(MAX_LOGQL_CHARS).describe(`LogQL query, at most ${MAX_LOGQL_CHARS} characters.`),
    since: scopeShape.since,
    until: scopeShape.until,
    limit: limitParam(50, 200),
  }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (i: Item) => (i.kind === "line" ? `${i.ts} ${JSON.stringify(i.labels)}: ${i.line}` : `${JSON.stringify(i.labels)} ${JSON.stringify(i.points)}`),
  async handler(args, ctx) {
    const loki = withSignal(ctx.loki, ctx.signal);
    const { query: logql, isLog: logQuery } = analyzeLogql(args.logql);
    const window = clampWindow(resolveWindow(args, ctx.now()), logQuery ? DAY_MS : 7 * DAY_MS);
    const note = window.clamped ? ` (window capped at ${logQuery ? "24h" : "7d"})` : "";
    const start = toNs(window.from);
    const end = toNs(window.to);

    if (logQuery) {
      const data = await loki.queryRange({ query: logql, start, end, limit: args.limit + 1, direction: "backward" });
      if (data.type !== "streams") return { summary: "no lines", items: [], window };
      const lines = data.streams.flatMap((s) => s.values.map(([ns, line]) => ({ ns, labels: s.labels, line }))).sort((a, b) => (a.ns === b.ns ? 0 : a.ns < b.ns ? 1 : -1));
      const items: Item[] = lines.slice(0, args.limit).map((l) => ({ kind: "line", labels: knownLabels(l.labels), ts: isoNs(l.ns), line: cleanLine(l.line) }));
      return { summary: `${items.length} line${items.length === 1 ? "" : "s"}${note}`, items, truncated: lines.length > args.limit, window };
    }

    const step = Math.max(1, Math.ceil((window.to.getTime() - window.from.getTime()) / 1000 / MAX_POINTS));
    const data = await loki.queryRange({ query: logql, start, end, step });
    if (data.type !== "series") return { summary: "the query returned log lines, not metrics", items: [], window };
    const items: Item[] = data.series.slice(0, MAX_SERIES).map((s) => ({ kind: "series", labels: metricLabels(s.labels), points: s.points.slice(-MAX_POINTS) }));
    return { summary: `${items.length} series, step ${step}s${note}`, items, truncated: data.series.length > MAX_SERIES, window };
  },
});
