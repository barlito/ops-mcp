import { z } from "zod";
import { anyOf, eq } from "../metrics/labels";
import { NO_DATA, formatMetric, MAX_WINDOW_MS, metricItem, MetricItemSchema, type MetricItem, minStepSeconds } from "../metrics/series";
import { clampWindow, nameParam, defineTool, envelopeSchema, resolveServers, resolveWindow, scopeShape } from "./contract";

const inputSchema = z.object({
  server: nameParam.describe("Server slug (see ops_list_servers)."),
  service: nameParam.describe("Full Swarm service name, e.g. carapp_php (label service_name)."),
  since: scopeShape.since,
  until: scopeShape.until,
});

export const opsServiceMetrics = defineTool({
  name: "ops_service_metrics",
  description:
    "Resource metrics of one service over a window of at most 7 days: CPU (cores), memory working set and % of its limit, container starts, network rx/tx, and from Traefik requests/s, 5xx/s and p95 latency. Each metric gives min/max/avg/last and a sparkline (max 30 points). A metric without series is null with a note, not an error. Traefik names its services after the traefik.http.services.<name> label, so its series are matched on the Swarm service name, its stack prefix (carapp_php -> carapp) or the auto-generated name (carapp-php); a note says when only the stack-level Traefik service matched.",
  inputSchema,
  outputSchema: envelopeSchema(MetricItemSchema),
  formatItem: formatMetric,
  async handler(args, ctx) {
    resolveServers(ctx.registry, args.server);
    const window = clampWindow(resolveWindow(args, ctx.now()), MAX_WINDOW_MS);
    const step = minStepSeconds(window);
    const range = `${Math.max(step, 60)}s`;
    const span = `${Math.round((window.to.getTime() - window.from.getTime()) / 1000)}s`;
    const sel = `${eq("server", args.server)},${eq("service_name", args.service)}`;
    const stack = args.service.includes("_") ? args.service.slice(0, args.service.indexOf("_")) : undefined;
    const autoName = args.service.replace(/[^a-zA-Z0-9]/g, "-");
    const names = [...new Set([args.service, ...(stack ? [stack] : []), autoName])];
    const traefik = `${eq("server", args.server)},${anyOf("service", names, "@.+")}`;
    const started = `max_over_time(container_start_time_seconds{${sel}}[${span}])`;
    const requests = `traefik_service_requests_total{${traefik}}`;

    const ranged = (metric: string, unit: string, promql: string, emptyNote?: string): Promise<MetricItem> =>
      ctx.prom.queryRange(promql, window, step, { signal: ctx.signal }).then((series) => metricItem(metric, unit, series[0], emptyNote, window.to.getTime() / 1000 - step));

    const [cpu, memory, memoryPct, restarts, rx, tx, rps, errors, p95, matched] = await Promise.all([
      ranged("cpu", "cores", `sum(rate(container_cpu_usage_seconds_total{${sel}}[${range}]))`),
      ranged("memory_working_set", "MiB", `sum(container_memory_working_set_bytes{${sel}}) / 1048576`),
      ranged("memory_of_limit", "%", `100 * sum(container_memory_working_set_bytes{${sel}}) / (sum(container_spec_memory_limit_bytes{${sel}}) > 0)`, "no memory limit set"),
      ctx.prom
        .query(`count(${started} > ${Math.floor(window.from.getTime() / 1000)}) or (count(${started}) * 0)`, window.to, { signal: ctx.signal })
        .then((s) => restartItem(s[0]?.value)),
      ranged("network_rx", "B/s", `sum(rate(container_network_receive_bytes_total{${sel}}[${range}]))`),
      ranged("network_tx", "B/s", `sum(rate(container_network_transmit_bytes_total{${sel}}[${range}]))`),
      ranged("traefik_requests", "req/s", `sum(rate(${requests}[${range}]))`, "no Traefik traffic for this service name"),
      ranged("traefik_5xx", "req/s", `sum(rate(traefik_service_requests_total{${traefik},code=~"5.."}[${range}])) or (sum(rate(${requests}[${range}])) * 0)`, "no Traefik traffic for this service name"),
      ranged("traefik_p95_latency", "s", `histogram_quantile(0.95, sum by (le) (rate(traefik_service_request_duration_seconds_bucket{${traefik}}[${range}])))`, "no Traefik traffic for this service name"),
      ctx.prom.query(`count by (service) (max_over_time(${requests}[${span}]))`, window.to, { signal: ctx.signal }),
    ]);

    const matchedServices = matched.flatMap((s) => (s.labels.service ? [s.labels.service] : []));
    const stackLevelOnly = stack !== undefined && matchedServices.length > 0 && matchedServices.every((m) => m.split("@")[0] === stack);
    const shared = (i: MetricItem): MetricItem => (stackLevelOnly && i.last !== null && !i.note ? { ...i, note: `Traefik service ${matchedServices.join(", ")} is shared by the whole stack` } : i);
    const all = [cpu, memory, memoryPct, restarts, rx, tx, shared(rps), shared(errors), shared(p95)];
    const withData = all.filter((i) => i.last !== null).length;
    // The generic "not running / not scraped" hint only makes sense when nothing at all was found.
    const items = withData === 0 ? all : all.map((i) => (i.note === NO_DATA ? { ...i, note: "no data for this metric" } : i));
    const clamped = window.clamped ? " (window clamped to 7d)" : "";
    return {
      summary: `${args.service} on ${args.server}: ${withData} of ${items.length} metrics have data, step ${step}s${clamped}`,
      items,
      window: { from: window.from, to: window.to },
      scope: { server: args.server, service: args.service },
    };
  },
});

function restartItem(count: number | undefined): MetricItem {
  if (count === undefined) return metricItem("container_starts", "count", undefined);
  return { metric: "container_starts", unit: "count", min: count, max: count, avg: count, last: count, points: [count], sparkline: "" };
}
