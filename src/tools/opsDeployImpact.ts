import { z } from "zod";
import { timeOf } from "../cluster/swarm";
import { linkOf, resolveRepo } from "../github/fuse";
import { countLines } from "../logs/count";
import { levelPatterns } from "../logs/patterns";
import { withSignal } from "../logs/LokiClient";
import { eq } from "../metrics/labels";
import { containerStartsQuery, requestsSeries, spanSeconds, stackLevelOnly, traefikScope } from "../metrics/serviceQueries";
import { redactAll } from "../platform/redact/secrets";
import { ToolError, type TimeWindow, defineTool, envelopeSchema, nameParam, parseInstant, resolveServers, scopeShape } from "./contract";

const MINUTE_MS = 60_000;
const DEFAULT_WINDOW_MS = 30 * MINUTE_MS;
const MAX_WINDOW_MS = 120 * MINUTE_MS;
const MIN_WINDOW_MS = MINUTE_MS;
// A Swarm update this close after the GitHub deployment is the rollout of that deployment.
const ROLLOUT_MS = 30 * MINUTE_MS;
const TOP_PATTERNS = 3;
const FAILED_STATES = new Set(["failed", "rejected"]);

const MetricSchema = z.object({
  kind: z.literal("metric"),
  metric: z.string(),
  unit: z.string(),
  before: z.number().nullable(),
  after: z.number().nullable(),
  delta: z.number().nullable(),
  note: z.string().optional(),
});
const PatternSchema = z.object({ kind: z.literal("pattern"), level: z.string(), pattern: z.string(), count: z.number(), example: z.string() });
const ItemSchema = z.discriminatedUnion("kind", [MetricSchema, PatternSchema]);
type Item = z.infer<typeof ItemSchema>;
type Metric = z.infer<typeof MetricSchema>;

interface Reading {
  value: number | null;
  note?: string;
}

const sig = (v: number): number => Number(v.toPrecision(4));
const show = (v: number | null): string => (v === null ? "n/a" : String(v));

// A failing backend only costs its own metric; a cancelled call still aborts the whole tool.
async function read(fn: () => Promise<number | null>): Promise<Reading> {
  try {
    const value = await fn();
    return { value: value === null ? null : sig(value) };
  } catch (err) {
    if (err instanceof ToolError && err.code === "cancelled") throw err;
    return { value: null, note: err instanceof ToolError ? redactAll(err.message) : "query failed" };
  }
}

function metric(name: string, unit: string, before: Reading, after: Reading, ...notes: Array<string | undefined>): Metric {
  const missing = before.value === null || after.value === null;
  const all = [before.note, after.note, ...notes, missing && !before.note && !after.note ? "no data" : undefined].filter((n): n is string => Boolean(n));
  return {
    kind: "metric",
    metric: name,
    unit,
    before: before.value,
    after: after.value,
    delta: missing ? null : sig(after.value! - before.value!),
    ...(all.length ? { note: [...new Set(all)].join("; ") } : {}),
  };
}

export const opsDeployImpact = defineTool({
  name: "ops_deploy_impact",
  description:
    "Did a deploy break something? Compares equal windows before and after a deploy of one service: error log lines (error and above) and the top 3 new error patterns (present after, absent before), Traefik 5xx rate (%) and p95 latency (ms), container starts and Swarm failed tasks. Give deploy_id (GitHub deployment id from ops_recent_deploys, needs the GitHub token) or ts (RFC 3339 instant of the deploy). When deploy_id matches a Swarm update within 30 minutes, the rollout time of that update is the instant. If the after-window ends in the future both windows are shortened to the elapsed time, and the summary says so. A metric without data is null with a note. Container starts include the rollout's own containers. Traefik series are matched on the Swarm service name, its stack prefix or the auto-generated name; a note says when only the stack-level Traefik service matched.",
  inputSchema: z.object({
    server: nameParam.describe("Server slug (see ops_list_servers)."),
    service: nameParam.describe("Full Swarm service name, e.g. carapp_php."),
    deploy_id: z.number().int().positive().optional().describe("GitHub deployment id (from ops_recent_deploys, field github.deployment_id)."),
    ts: scopeShape.until.unwrap().optional().describe("Deploy instant, RFC 3339. Alternative to deploy_id."),
    window: z.string().regex(/^\d{1,3}[mh]$/, "window must be a duration like 15m, 30m or 2h").optional().describe("Length of each of the two windows (default 30m, max 2h)."),
  }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (i: Item) =>
    i.kind === "pattern"
      ? `NEW ${i.level} PATTERN x${i.count} ${i.pattern} | e.g. ${i.example}`
      : `${i.metric} (${i.unit}) ${show(i.before)} -> ${show(i.after)}${i.delta === null ? "" : ` (${i.delta > 0 ? "+" : ""}${i.delta})`}${i.note ? ` [${i.note}]` : ""}`,
  async handler(args, ctx) {
    if ((args.deploy_id === undefined) === (args.ts === undefined)) throw new ToolError("invalid_arguments", "Give exactly one of deploy_id or ts.");
    const [server] = resolveServers(ctx.registry, args.server);
    const length = args.window === undefined ? DEFAULT_WINDOW_MS : Number(args.window.slice(0, -1)) * (args.window.endsWith("h") ? 60 : 1) * MINUTE_MS;
    if (length > MAX_WINDOW_MS) throw new ToolError("invalid_window", "window is at most 2h.");

    const service = await ctx.cluster(server!).getService(args.service, { signal: ctx.signal });
    const swarmAt = timeOf(service.updated_at);
    let instant: number;
    let version: string | undefined;
    if (args.deploy_id !== undefined) {
      if (!ctx.github) throw new ToolError("backend_unavailable", "GitHub Deployments are not configured: pass ts instead of deploy_id.");
      const repo = resolveRepo(service, ctx.registry);
      if (repo === undefined) throw new ToolError("invalid_arguments", `No repository known for ${args.service} (label fr.barlito.repo or registry stack_projects): pass ts instead of deploy_id.`);
      const deployment = await ctx.github.deployment(repo, args.deploy_id, { signal: ctx.signal });
      const created = Date.parse(deployment.created_at);
      const rolledOut = swarmAt >= created && swarmAt - created <= ROLLOUT_MS;
      instant = rolledOut ? swarmAt : created;
      version = linkOf(deployment, rolledOut ? service.image.tag : undefined).tag;
    } else {
      instant = parseInstant(args.ts!, "ts").getTime();
      version = Math.abs(swarmAt - instant) <= ROLLOUT_MS ? service.image.tag : undefined;
    }

    const now = ctx.now().getTime();
    if (instant >= now) throw new ToolError("invalid_window", "The deploy instant is in the future.");
    const span = Math.min(length, now - instant);
    if (span < MIN_WINDOW_MS) throw new ToolError("invalid_window", "The deploy is too recent to compare: wait at least a minute.");
    const before: TimeWindow = { from: new Date(instant - span), to: new Date(instant) };
    const after: TimeWindow = { from: new Date(instant), to: new Date(instant + span) };
    const partial = span < length;

    const loki = withSignal(ctx.loki, ctx.signal);
    const scope = { server: args.server, service: args.service };
    const prom = (promql: string, w: TimeWindow): Promise<number | null> => ctx.prom.query(promql, w.to, { signal: ctx.signal }).then((s) => s[0]?.value ?? null);
    const { matcher, stack } = traefikScope(args.server, args.service);
    const requests = requestsSeries(matcher);
    const increase = (w: TimeWindow, selectorExtra = ""): string => `sum(increase(traefik_service_requests_total{${matcher}${selectorExtra}}[${spanSeconds(w)}s]))`;
    const errorRate = (w: TimeWindow): string => `100 * (${increase(w, ',code=~"5.."')} or (${increase(w)} * 0)) / ${increase(w)}`;
    const p95 = (w: TimeWindow): string => `1000 * histogram_quantile(0.95, sum by (le) (increase(traefik_service_request_duration_seconds_bucket{${matcher}}[${spanSeconds(w)}s])))`;
    const both = <T>(fn: (w: TimeWindow) => Promise<T>): Promise<[T, T]> => Promise.all([fn(before), fn(after)]);
    const failedTasks = async (): Promise<Array<{ at: number; error?: string }>> =>
      (await ctx.cluster(server!).listTasks({ service: args.service }, { signal: ctx.signal })).filter((t) => FAILED_STATES.has(t.state)).map((t) => ({ at: timeOf(t.updated_at), error: t.error }));
    const unavailable = (err: unknown, what: string): string => {
      if (err instanceof ToolError && err.code === "cancelled") throw err;
      return err instanceof ToolError ? redactAll(err.message) : `${what} unavailable`;
    };
    const inside = (at: number, w: TimeWindow): boolean => at >= w.from.getTime() && at < w.to.getTime();

    const [errors, patterns, rate, latency, starts, matched, tasks] = await Promise.all([
      both((w) => read(() => countLines(loki, scope, "error", w))),
      Promise.all([levelPatterns(loki, scope, "error", before), levelPatterns(loki, scope, "error", after)]).then(
        (groups) => ({ groups }),
        (err: unknown) => ({ error: unavailable(err, "pattern lookup") }),
      ),
      both((w) => read(() => prom(errorRate(w), w))),
      both((w) => read(() => prom(p95(w), w))),
      both((w) => read(() => prom(containerStartsQuery(args.server, args.service, w), w))),
      ctx.prom.query(`count by (service) (max_over_time(${requests}[${spanSeconds(after)}s]))`, after.to, { signal: ctx.signal }).catch((err: unknown) => {
        unavailable(err, "Traefik lookup");
        return [];
      }),
      failedTasks().then(
        (list): { list: typeof list; note?: string } => ({ list }),
        (err: unknown): { list: []; note?: string } => ({ list: [], note: unavailable(err, "Swarm tasks") }),
      ),
    ]);

    const shared = stackLevelOnly(stack, matched.flatMap((s) => (s.labels.service ? [s.labels.service] : []))) ? `Traefik service ${matched.map((s) => s.labels.service).join(", ")} is shared by the whole stack` : undefined;
    const noTraffic = "no Traefik traffic for this service name";
    const taskCount = (w: TimeWindow): Reading => ({ value: tasks.note ? null : tasks.list.filter((t) => inside(t.at, w)).length });
    const latestError = tasks.list.filter((t) => inside(t.at, after) && t.error).sort((a, b) => b.at - a.at)[0]?.error;
    const patternNote = "error" in patterns ? `new error patterns unavailable: ${patterns.error}` : undefined;

    const metrics: Metric[] = [
      metric("error_logs", "lines", errors[0], errors[1], patternNote),
      metric("traefik_5xx", "%", rate[0], rate[1], rate[0].value === null || rate[1].value === null ? noTraffic : shared),
      metric("traefik_p95_latency", "ms", latency[0], latency[1], latency[0].value === null || latency[1].value === null ? noTraffic : shared),
      metric("container_starts", "count", starts[0], starts[1], "after includes the rollout's own containers"),
      metric("swarm_failed_tasks", "count", taskCount(before), taskCount(after), tasks.note ?? "Swarm keeps only a few past tasks per slot", latestError ? `latest after: ${latestError.slice(0, 120)}` : undefined),
    ];
    const newPatterns: Item[] =
      "groups" in patterns
        ? (() => {
            const known = new Set(patterns.groups[0].map((g) => g.pattern));
            return patterns.groups[1]
              .filter((g) => !known.has(g.pattern))
              .sort((a, b) => b.count - a.count)
              .slice(0, TOP_PATTERNS)
              .map((g) => ({ kind: "pattern", level: g.level, pattern: g.pattern, count: g.count, example: g.example }));
          })()
        : [];

    const by = new Map(metrics.map((m) => [m.metric, m]));
    const fmt = (name: string, label: string, each = "", tail = ""): string | undefined => {
      const m = by.get(name)!;
      return m.before === null || m.after === null ? undefined : `${label} ${m.before}${each}→${m.after}${each}${tail}`;
    };
    const failedTaskChange = by.get("swarm_failed_tasks")!;
    const parts = [
      fmt("error_logs", "errors"),
      fmt("traefik_5xx", "5xx", "%"),
      fmt("traefik_p95_latency", "p95", "", " ms"),
      newPatterns.length ? `${newPatterns.length} new error pattern${newPatterns.length === 1 ? "" : "s"}` : undefined,
      failedTaskChange.after ? `${failedTaskChange.after} failed task${failedTaskChange.after === 1 ? "" : "s"} after` : undefined,
    ].filter((p): p is string => p !== undefined);
    const lead = `${args.service}${version ? ` ${version}` : ""}`;
    return {
      summary: `${lead}: ${parts.length ? parts.join(", ") : "no comparable data"}${partial ? ` (after-window partial: ${Math.round(span / MINUTE_MS)} of ${Math.round(length / MINUTE_MS)} min)` : ""}`,
      items: [...metrics, ...newPatterns],
      window: { from: before.from, to: after.to },
      scope,
    };
  },
});
