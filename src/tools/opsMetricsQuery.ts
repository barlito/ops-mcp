import { z } from "zod";
import { MAX_POINTS, MAX_WINDOW_MS, minStepSeconds, SPARKLINE_POINTS, downsample, sparkline, stats } from "../metrics/series";
import { clampWindow, defineTool, envelopeSchema, resolveWindow, scopeShape } from "./contract";

export const MAX_SERIES = 20;
const STEP_RE = /^(\d{1,5})([smh])$/;
const STEP_UNIT = { s: 1, m: 60, h: 3600 } as const;

const inputSchema = z.object({
  promql: z.string().min(1).max(2000).describe("PromQL expression, evaluated as a range query. Series carry the labels server, deployment_environment and, for containers, service_namespace, service_name, container, host_name."),
  since: scopeShape.since,
  until: scopeShape.until,
  step: z
    .string()
    .regex(STEP_RE, "step must be like 30s, 5m or 1h")
    .optional()
    .describe(`Resolution step (30s, 5m, 1h). Raised automatically so a series has at most ${MAX_POINTS} points.`),
});

const ItemSchema = z.object({
  labels: z.record(z.string(), z.string()),
  min: z.number().nullable(),
  max: z.number().nullable(),
  avg: z.number().nullable(),
  last: z.number().nullable(),
  sparkline: z.string(),
  // [unix seconds, value]
  samples: z.array(z.tuple([z.number(), z.number()])),
});
type Item = z.infer<typeof ItemSchema>;

const formatItem = (i: Item): string =>
  `{${Object.entries(i.labels).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")}} ${i.sparkline} min=${i.min} max=${i.max} avg=${i.avg} last=${i.last}`;

export const opsMetricsQuery = defineTool({
  name: "ops_metrics_query",
  description: `Raw PromQL range query over a window of at most 7 days, for what the other metric tools do not cover. At most ${MAX_SERIES} series of ${MAX_POINTS} points each; the step is raised when needed. Any authenticated client may run any query (read-only).`,
  inputSchema,
  outputSchema: envelopeSchema(ItemSchema),
  formatItem,
  async handler(args, ctx) {
    const window = clampWindow(resolveWindow(args, ctx.now()), MAX_WINDOW_MS);
    const m = args.step ? STEP_RE.exec(args.step) : null;
    const requested = m ? Number(m[1]) * STEP_UNIT[m[2] as keyof typeof STEP_UNIT] : 0;
    const step = Math.max(minStepSeconds(window), requested);
    const series = await ctx.prom.queryRange(args.promql, window, step, { signal: ctx.signal, limit: MAX_SERIES + 1 });
    const items = series.slice(0, MAX_SERIES).map((s): Item => {
      const values = s.points.map(([, v]) => v);
      return { labels: s.labels, ...stats(values), sparkline: sparkline(downsample(values, SPARKLINE_POINTS)), samples: s.points.slice(0, MAX_POINTS) };
    });
    const notes = [
      requested > 0 && step > requested ? `step raised from ${args.step} to ${step}s` : "",
      series.length > MAX_SERIES ? `more than ${MAX_SERIES} series, showing the first ${MAX_SERIES}: narrow the query` : "",
      window.clamped ? "window clamped to 7d" : "",
    ].filter(Boolean);
    return {
      summary: `${series.length > MAX_SERIES ? MAX_SERIES : series.length} series, step ${step}s${notes.length ? `; ${notes.join("; ")}` : ""}`,
      items,
      truncated: series.length > MAX_SERIES,
      window: { from: window.from, to: window.to },
    };
  },
});
