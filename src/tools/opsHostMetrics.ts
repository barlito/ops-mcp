import { z } from "zod";
import { eq } from "../metrics/labels";
import { cpuPct, diskDaysUntilFull, diskUsedPct, ramPct } from "../metrics/nodeQueries";
import type { PromSeries } from "../metrics/PromClient";
import { formatMetric, MAX_WINDOW_MS, metricItem, MetricItemSchema, type MetricItem, minStepSeconds, NO_DATA } from "../metrics/series";
import { clampWindow, defineTool, envelopeSchema, resolveServers, resolveWindow, scopeShape } from "./contract";

const inputSchema = z.object({
  server: z.string().min(1).describe("Server slug (see ops_list_servers)."),
  host: z.string().min(1).optional().describe("Node hostname (label host_name). Omit for every node of the server."),
  since: scopeShape.since,
  until: scopeShape.until,
});

const ItemSchema = MetricItemSchema.extend({
  host: z.string().nullable(),
  mountpoint: z.string().optional(),
  days_until_full: z.number().nullable().optional(),
});
type Item = z.infer<typeof ItemSchema>;

const formatItem = (i: Item): string =>
  [i.host ? `${i.host}:` : "", i.mountpoint ?? "", formatMetric(i), i.days_until_full !== undefined ? `days_until_full=${i.days_until_full ?? "none"}` : ""].filter(Boolean).join(" ");

export const opsHostMetrics = defineTool({
  name: "ops_host_metrics",
  description:
    "Node metrics of a server over a window of at most 7 days: CPU %, load 1/5/15, RAM %, disk usage per mountpoint with the days left until full at the recent trend (null when it is not filling within a year), and disk I/O. One item per host and metric (per mountpoint for disks), each with min/max/avg/last and a sparkline (max 30 points).",
  inputSchema,
  outputSchema: envelopeSchema(ItemSchema),
  formatItem,
  async handler(args, ctx) {
    resolveServers(ctx.registry, args.server);
    const window = clampWindow(resolveWindow(args, ctx.now()), MAX_WINDOW_MS);
    const step = minStepSeconds(window);
    const range = `${Math.max(step, 60)}s`;
    const span = (window.to.getTime() - window.from.getTime()) / 1000;
    const sel = [eq("server", args.server), ...(args.host ? [eq("host_name", args.host)] : [])].join(",");

    const perHost = async (metric: string, unit: string, promql: string, byMountpoint = false): Promise<Item[]> => {
      const series: PromSeries[] = await ctx.prom.queryRange(promql, window, step);
      if (series.length === 0) return [{ ...metricItem(metric, unit, undefined, NO_DATA), host: args.host ?? null }];
      return series.map((s) => ({ ...metricItem(metric, unit, s), host: s.labels.host_name ?? null, ...(byMountpoint ? { mountpoint: s.labels.mountpoint ?? "" } : {}) }));
    };

    const lookback = `${Math.round(Math.min(MAX_WINDOW_MS / 1000, Math.max(span, 6 * 3600)))}s`;
    const [groups, fill] = await Promise.all([
      Promise.all([
        perHost("cpu", "%", cpuPct(sel, range)),
        perHost("load1", "load", `max by (host_name) (node_load1{${sel}})`),
        perHost("load5", "load", `max by (host_name) (node_load5{${sel}})`),
        perHost("load15", "load", `max by (host_name) (node_load15{${sel}})`),
        perHost("ram", "%", `max by (host_name) (${ramPct(sel)})`),
        perHost("disk_used", "%", diskUsedPct(sel), true),
        perHost("disk_io_util", "%", `100 * max by (host_name) (rate(node_disk_io_time_seconds_total{${sel},device!~"loop.*|ram.*"}[${range}]))`),
        perHost("disk_read", "B/s", `sum by (host_name) (rate(node_disk_read_bytes_total{${sel},device!~"loop.*|ram.*"}[${range}]))`),
        perHost("disk_write", "B/s", `sum by (host_name) (rate(node_disk_written_bytes_total{${sel},device!~"loop.*|ram.*"}[${range}]))`),
      ]),
      ctx.prom.query(diskDaysUntilFull(sel, lookback), window.to),
    ]);

    const days = new Map(fill.map((s) => [`${s.labels.host_name}|${s.labels.mountpoint}`, Math.round(s.value * 10) / 10]));
    const items = groups.flat().map((i): Item => (i.mountpoint === undefined ? i : { ...i, days_until_full: i.last === null ? null : (days.get(`${i.host}|${i.mountpoint}`) ?? null) }));
    const withData = items.filter((i: MetricItem) => i.last !== null).length;
    return {
      summary: `${args.host ?? args.server}: ${withData} of ${items.length} metrics have data, step ${step}s${window.clamped ? " (window clamped to 7d)" : ""}`,
      items,
      window: { from: window.from, to: window.to },
      scope: { server: args.server },
    };
  },
});
