import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServiceDetail, TaskInfo } from "../cluster/types";
import { ghDeployment } from "../test-support/github";
import type { LokiApi, LokiData } from "../logs/LokiClient";
import type { PromApi } from "../metrics/PromClient";
import { connect, fakeProm, stubSource, textOf } from "../test-support/mcp";
import { ToolError } from "./contract";
import { opsDeployImpact } from "./opsDeployImpact";

const TS = "2026-06-01T11:30:00Z";
const ts = Date.parse(TS);

const detail = (updated = "2026-06-01T11:31:00.000Z", status?: ServiceDetail["update_status"], tag = "v1.4.3"): ServiceDetail => ({
  id: "carapp_php",
  name: "carapp_php",
  stack: "carapp",
  mode: "replicated",
  desired: 2,
  running: 2,
  image: { name: "barlito/carapp", tag },
  ...(status ? { update_status: status } : {}),
  labels: { "fr.barlito.repo": "barlito/carapp" },
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: updated,
  networks: [],
  constraints: [],
  ports: [],
  routes: [],
  secrets: [],
  configs: [],
});

const task = (state: string, updated: string, error?: string): TaskInfo => ({ id: updated, service: "carapp_php", state, desired_state: "running", error, created_at: updated, updated_at: updated });

const cluster = (over: { updated?: string; tasks?: TaskInfo[]; status?: ServiceDetail["update_status"]; tag?: string } = {}) => () =>
  stubSource({ getService: async () => detail(over.updated, over.status, over.tag), listTasks: async () => over.tasks ?? [task("failed", "2026-06-01T11:36:00Z", "task: non-zero exit (1)"), task("failed", "2026-06-01T11:40:00Z", "task: non-zero exit (1)"), task("failed", "2026-06-01T10:00:00Z")] });

const isAfter = (ns: bigint | number, instant = ts, strict = false): boolean => {
  const ms = typeof ns === "bigint" ? Number(ns / 1_000_000n) : ns * 1000;
  return strict ? ms > instant : ms >= instant;
};

const logs = (before: string[], after: string[], instant = ts): LokiApi => ({
  query: async (p): Promise<LokiData> => ({ type: "series", series: [{ labels: {}, points: [[0, String(isAfter(p.time, instant, true) ? after.length : before.length)]] }] }),
  queryRange: async (p): Promise<LokiData> => {
    const lines = isAfter(p.start, instant) ? after : before;
    return { type: "streams", streams: [{ labels: { server: "ovh-prod-1", service_name: "carapp_php", detected_level: "error" }, values: lines.map((l, i): [bigint, string] => [p.end - BigInt(i + 1) * 1000n, l]) }] };
  },
});

const rep = (line: string, n: number): string[] => Array.from({ length: n }, (_, i) => line.replace("#", String(i)));
const OLD = rep("timeout talking to db host 10.0.0.#", 2);
const AFTER = [
  ...OLD,
  ...rep("SQLSTATE[42S22]: Column not found: unknown column # in users", 20),
  ...rep("Undefined index payload at line #", 10),
  ...rep("Cache pool unreachable after # retries", 6),
  ...rep("Rare failure code #", 3),
  "Single oddity happened once",
];

const prom = (rows: { rate: [number, number]; p95: [number, number]; starts: [number, number]; matched?: string[] }, seen: string[] = [], instant = ts): PromApi =>
  fakeProm({
    query: async (q, at) => {
      seen.push(q);
      const i = at.getTime() > instant ? 1 : 0;
      if (q.startsWith("count by (service)")) return (rows.matched ?? ["carapp_php@docker"]).map((service) => ({ labels: { service }, value: 1 }));
      if (q.includes("histogram_quantile")) return [{ labels: {}, value: rows.p95[i]! }];
      if (q.includes("container_start_time_seconds")) return [{ labels: {}, value: rows.starts[i]! }];
      return [{ labels: {}, value: rows.rate[i]! }];
    },
  });
const fullProm = (seen?: string[]) => prom({ rate: [0.1, 3.2], p95: [180, 950], starts: [0, 2] }, seen);

type Item = Record<string, any>;
const metrics = (r: { structuredContent?: Record<string, unknown> }) => new Map((r.structuredContent?.items as Item[]).filter((i) => i.kind === "metric").map((i) => [i.metric, i]));

test("compares equal windows around the deploy: deltas, top 3 new error patterns, task failures", async () => {
  const seen: string[] = [];
  const { call } = await connect([opsDeployImpact], { cluster: cluster(), loki: logs(OLD, AFTER), prom: fullProm(seen) });
  const r = await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", ts: TS });
  assert.ok(!r.isError, textOf(r));
  const m = metrics(r);
  assert.deepEqual([m.get("error_logs")!.before, m.get("error_logs")!.after, m.get("error_logs")!.delta], [2, 42, 40]);
  assert.deepEqual([m.get("traefik_5xx")!.before, m.get("traefik_5xx")!.after, m.get("traefik_5xx")!.delta], [0.1, 3.2, 3.1]);
  assert.deepEqual([m.get("traefik_p95_latency")!.before, m.get("traefik_p95_latency")!.after, m.get("traefik_p95_latency")!.delta], [180, 950, 770]);
  assert.deepEqual([m.get("container_starts")!.before, m.get("container_starts")!.after], [0, 2]);
  assert.deepEqual([m.get("swarm_failed_tasks")!.before, m.get("swarm_failed_tasks")!.after], [0, 2]);
  assert.match(m.get("swarm_failed_tasks")!.note, /latest after: task: non-zero exit \(1\)/);
  const patterns = (r.structuredContent?.items as Item[]).filter((i) => i.kind === "pattern");
  assert.deepEqual(patterns.map((p) => p.count), [20, 10, 6]);
  assert.ok(patterns.every((p) => !p.pattern.includes("timeout talking") && !p.pattern.includes("Single oddity")));
  assert.equal(r.structuredContent?.summary, "carapp_php v1.4.3: errors 2→42, 5xx 0.1%→3.2%, p95 180→950 ms, 3 new error patterns, 2 failed tasks after");
  assert.deepEqual(r.structuredContent?.window, { from: "2026-06-01T11:00:00.000Z", to: "2026-06-01T12:00:00.000Z" });
  assert.ok(seen.some((q) => q.includes(String.raw`service=~"(carapp_php|carapp|carapp\\-php)@.+"`) && q.includes('server="ovh-prod-1"')));
  assert.match(textOf(r), /^error_logs \(lines\) 2 -> 41 \(\+39\)/m);
});

test("deploy_id takes the instant from the Swarm rollout of that deployment and labels the version", async () => {
  const asked: Array<[string, number]> = [];
  const github = { recentDeployments: async () => [], deployment: async (repo: string, id: number) => (asked.push([repo, id]), ghDeployment({ id, ref: "v1.4.3", created_at: "2026-06-01T11:29:00Z" })) };
  const { call } = await connect([opsDeployImpact], { cluster: cluster(), loki: logs(OLD, AFTER, ts + 60_000), prom: prom({ rate: [0.1, 3.2], p95: [180, 950], starts: [0, 2] }, [], ts + 60_000), github });
  const r = await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", deploy_id: 10, window: "15m" });
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(asked, [["barlito/carapp", 10]]);
  assert.deepEqual(r.structuredContent?.window, { from: "2026-06-01T11:16:00.000Z", to: "2026-06-01T11:46:00.000Z" });
  assert.match(r.structuredContent?.summary as string, /^carapp_php v1\.4\.3: errors 2→42/);
});

test("a rollback deployment has no tag of its own: the version comes from Swarm", async () => {
  const github = { recentDeployments: async () => [], deployment: async () => ghDeployment({ id: 9, ref: "main", created_at: "2026-06-01T11:29:00Z", creator: "github-actions" }) };
  const { call } = await connect([opsDeployImpact], { cluster: cluster(), loki: logs([], [], ts + 60_000), prom: fullProm(), github });
  const r = await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", deploy_id: 9 });
  assert.match(r.structuredContent?.summary as string, /^carapp_php v1\.4\.3 /);
});

test("a deploy less than a window ago shortens both windows and says so", async () => {
  const instant = Date.parse("2026-06-01T11:45:00Z");
  const { call } = await connect([opsDeployImpact], { cluster: cluster({ updated: "2026-06-01T11:46:00.000Z" }), loki: logs(OLD, AFTER, instant), prom: prom({ rate: [0.1, 3.2], p95: [180, 950], starts: [0, 2] }, [], instant) });
  const r = await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", ts: "2026-06-01T11:45:00Z" });
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(r.structuredContent?.window, { from: "2026-06-01T11:30:00.000Z", to: "2026-06-01T12:00:00.000Z" });
  assert.match(r.structuredContent?.summary as string, /^carapp_php v1\.4\.3 \(after-window partial: 15 of 30 min\): errors/);
  assert.ok(Buffer.byteLength(r.structuredContent?.summary as string) <= 240);
});

test("missing series and a failing Loki give nulls with notes, not errors", async () => {
  const loki: LokiApi = { query: () => Promise.reject(new ToolError("backend_unavailable", "Loki is unreachable.")), queryRange: () => Promise.reject(new ToolError("backend_unavailable", "Loki is unreachable.")) };
  const { call } = await connect([opsDeployImpact], { cluster: cluster({ tasks: [] }), loki, prom: fakeProm() });
  const r = await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", ts: TS });
  assert.ok(!r.isError, textOf(r));
  const m = metrics(r);
  for (const name of ["error_logs", "traefik_5xx", "traefik_p95_latency", "container_starts"]) {
    assert.deepEqual([m.get(name)!.before, m.get(name)!.after, m.get(name)!.delta], [null, null, null], name);
    assert.ok(m.get(name)!.note, name);
  }
  assert.match(m.get("error_logs")!.note, /Loki is unreachable/);
  assert.match(m.get("traefik_5xx")!.note, /no Traefik traffic/);
  assert.deepEqual([m.get("swarm_failed_tasks")!.before, m.get("swarm_failed_tasks")!.after], [0, 0]);
  assert.equal(r.structuredContent?.summary, "carapp_php v1.4.3: no comparable data");
});

test("a note says when only the stack-level Traefik service matched", async () => {
  const { call } = await connect([opsDeployImpact], { cluster: cluster(), loki: logs(OLD, AFTER), prom: prom({ rate: [0.1, 3.2], p95: [180, 950], starts: [0, 2], matched: ["carapp@docker"] }) });
  const r = await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", ts: TS });
  assert.match(metrics(r).get("traefik_5xx")!.note, /shared by the whole stack/);
});

test("argument errors", async () => {
  const github = { recentDeployments: async () => [], deployment: async () => ghDeployment({ id: 1 }) };
  const withGh = await connect([opsDeployImpact], { cluster: cluster(), github });
  const without = await connect([opsDeployImpact], { cluster: cluster() });
  const base = { server: "ovh-prod-1", service: "carapp_php" };
  const errorOf = async (c: typeof withGh, args: Record<string, unknown>) => textOf(await c.call("ops_deploy_impact", { ...base, ...args }));
  assert.match(await errorOf(withGh, {}), /^Error \[invalid_arguments\]/);
  assert.match(await errorOf(withGh, { ts: TS, deploy_id: 3 }), /^Error \[invalid_arguments\]/);
  assert.match(await errorOf(without, { deploy_id: 3 }), /^Error \[backend_unavailable\].*pass ts/);
  assert.match(await errorOf(withGh, { ts: TS, window: "3h" }), /^Error \[invalid_window\]/);
  assert.match(await errorOf(withGh, { ts: "2026-06-01T13:00:00Z" }), /^Error \[invalid_window\].*future/);
  assert.match(await errorOf(withGh, { ts: "2026-06-01T11:59:30Z" }), /^Error \[invalid_window\].*too recent/);
});

test("the instant is the start of the Swarm update, not its completion", async () => {
  const instant = Date.parse("2026-06-01T11:28:00Z");
  const github = { recentDeployments: async () => [], deployment: async () => ghDeployment({ id: 4, ref: "v1.4.3", created_at: "2026-06-01T11:25:00Z" }) };
  const status = { state: "completed", started_at: "2026-06-01T11:28:00.000Z" };
  const { call } = await connect([opsDeployImpact], { cluster: cluster({ status }), loki: logs(OLD, AFTER, instant), prom: prom({ rate: [0.1, 3.2], p95: [180, 950], starts: [0, 2] }, [], instant), github });
  const r = await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", deploy_id: 4 });
  assert.deepEqual(r.structuredContent?.window, { from: "2026-06-01T10:58:00.000Z", to: "2026-06-01T11:58:00.000Z" });
});

test("after a Swarm rollback the instant is the deployment, the version is the failed one and the summary says it rolled back", async () => {
  const status = { state: "rollback_completed", started_at: "2026-06-01T11:31:00.000Z" };
  const github = { recentDeployments: async () => [], deployment: async () => ghDeployment({ id: 4, ref: "v1.5.0", created_at: "2026-06-01T11:29:00Z" }) };
  const c = await connect([opsDeployImpact], { cluster: cluster({ status, tag: "v1.4.2" }), loki: logs(OLD, AFTER, Date.parse("2026-06-01T11:29:00Z")), prom: fullProm(), github });
  const r = await c.call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", deploy_id: 4 });
  assert.match(r.structuredContent?.summary as string, /^carapp_php v1\.5\.0 \(Swarm rolled back to v1\.4\.2\): errors/);
  assert.equal((r.structuredContent?.window as { from: string }).from, "2026-06-01T10:59:00.000Z");
  const byTs = await c.call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", ts: TS });
  assert.match(byTs.structuredContent?.summary as string, /^carapp_php \(Swarm rolled back to v1\.4\.2\): /);
});

test("a sample capped at 5000 lines is flagged and a window under one minute is refused", async () => {
  const many = Array.from({ length: 5000 }, (_, i) => `request ${i} failed with code E${i % 3}`);
  const { call } = await connect([opsDeployImpact], { cluster: cluster(), loki: logs(OLD, many), prom: fullProm() });
  const r = await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", ts: TS });
  assert.match(metrics(r).get("error_logs")!.note, /sampled from the newest 5000 lines/);
  assert.match(textOf(await call("ops_deploy_impact", { server: "ovh-prod-1", service: "carapp_php", ts: TS, window: "0m" })), /^Error \[invalid_window\]/);
});
