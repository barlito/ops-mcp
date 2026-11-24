// Runs against the real Prometheus of integration/metrics (see `make test.integration-metrics`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PromClient } from "../metrics/PromClient";
import { alertsSection } from "../overview/alertsSection";
import { metricsSection } from "../overview/metricsSection";
import { connect, textOf } from "../test-support/mcp";
import { testRegistry } from "../test-support/fixtures";
import { opsAlerts } from "../tools/opsAlerts";
import { opsHostMetrics } from "../tools/opsHostMetrics";
import { opsMetricsQuery } from "../tools/opsMetricsQuery";
import { opsServiceMetrics } from "../tools/opsServiceMetrics";

const prom = new PromClient(process.env.PROM_URL ?? "http://prometheus:9090");
const now = () => new Date();
const tools = [opsServiceMetrics, opsHostMetrics, opsMetricsQuery, opsAlerts];

type Item = { metric: string; host?: string | null; mountpoint?: string; last: number | null; days_until_full?: number | null; note?: string };
const near = (actual: number | null | undefined, expected: number, tolerance: number, what: string) =>
  assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) <= tolerance, `${what}: ${actual} not within ${tolerance} of ${expected}`);

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("ops_service_metrics reads the canonical labels, Cadvisor and Traefik series", async () => {
  const { call } = await connect(tools, { prom, now });
  const r = await call("ops_service_metrics", { server: "ovh-prod-1", service: "shop_web" });
  assert.ok(!r.isError, textOf(r));
  const m = new Map((r.structuredContent?.items as Item[]).map((i) => [i.metric, i]));
  near(m.get("cpu")?.last, 0.5, 0.05, "cpu");
  near(m.get("memory_working_set")?.last, 256, 0.5, "memory");
  near(m.get("memory_of_limit")?.last, 50, 0.1, "memory %");
  assert.equal(m.get("container_starts")?.last, 1);
  near(m.get("network_rx")?.last, 1000, 50, "rx");
  near(m.get("network_tx")?.last, 2000, 100, "tx");
  near(m.get("traefik_requests")?.last, 10, 0.5, "req/s");
  near(m.get("traefik_5xx")?.last, 1, 0.1, "5xx/s");
  near(m.get("traefik_p95_latency")?.last, 0.46, 0.03, "p95");
  assert.match(textOf(r), /^cpu \(cores\) [▁-█]+ /m);
});

test("server scoping: lab sees its own series and no Traefik data", async () => {
  const { call } = await connect(tools, { prom, now });
  const m = new Map(((await call("ops_service_metrics", { server: "lab", service: "shop_web" })).structuredContent?.items as Item[]).map((i) => [i.metric, i]));
  near(m.get("cpu")?.last, 0.4, 0.05, "lab cpu");
  assert.equal(m.get("traefik_requests")?.last, null);
  assert.match(m.get("traefik_requests")?.note ?? "", /no Traefik traffic/);
});

test("an unknown service is nulls with notes, not an error", async () => {
  const { call } = await connect(tools, { prom, now });
  const r = await call("ops_service_metrics", { server: "ovh-prod-1", service: "ghost_svc" });
  assert.ok(!r.isError);
  assert.ok((r.structuredContent?.items as Item[]).filter((i) => i.metric !== "container_starts").every((i) => i.last === null && i.note));
  assert.match(r.structuredContent?.summary as string, /0 of 9 metrics have data/);
});

test("ops_host_metrics: cpu, load, ram, disks (tmpfs excluded) and the fill prediction", async () => {
  const { call } = await connect(tools, { prom, now });
  const r = await call("ops_host_metrics", { server: "ovh-prod-1" });
  assert.ok(!r.isError, textOf(r));
  const items = r.structuredContent?.items as Item[];
  const one = (metric: string) => items.find((i) => i.metric === metric);
  assert.equal(one("cpu")?.host, "node-a");
  near(one("cpu")?.last, 25, 2, "cpu %");
  near(one("load1")?.last, 1.5, 0.01, "load1");
  near(one("load15")?.last, 1, 0.01, "load15");
  near(one("ram")?.last, 75, 0.1, "ram %");
  near(one("disk_io_util")?.last, 10, 1, "io util");
  near(one("disk_read")?.last, 1000, 50, "read");
  near(one("disk_write")?.last, 3000, 150, "write");
  const disks = items.filter((i) => i.metric === "disk_used");
  assert.deepEqual(disks.map((d) => d.mountpoint).sort(), ["/", "/data"]);
  const root = disks.find((d) => d.mountpoint === "/")!;
  near(root.last, 50, 0.5, "/ used %");
  near(root.days_until_full, 10, 0.3, "days until full");
  assert.equal(disks.find((d) => d.mountpoint === "/data")?.days_until_full, null);
  assert.equal((await call("ops_host_metrics", { server: "ovh-prod-1", host: "nope" })).structuredContent?.summary, "nope: 0 of 9 metrics have data, step 75s");
});

test("ops_metrics_query runs raw PromQL and maps Prometheus rejections", async () => {
  const { call } = await connect(tools, { prom, now });
  const r = await call("ops_metrics_query", { promql: "max by (server) (node_load1)", since: "2h" });
  assert.ok(!r.isError, textOf(r));
  const items = r.structuredContent?.items as Array<{ labels: Record<string, string>; samples: unknown[]; last: number }>;
  assert.deepEqual(items.map((i) => i.labels.server).sort(), ["lab", "ovh-prod-1"]);
  assert.ok(items.every((i) => i.samples.length <= 60 && i.last === 1.5));
  const bad = await call("ops_metrics_query", { promql: "sum(" });
  assert.match(textOf(bad), /^Error \[query_rejected\]: Prometheus rejected the query/);
});

test("ops_alerts and the overview sections see the firing and pending rules", async () => {
  await waitFor(async () => (await prom.alerts()).length === 2, "both alert rules to be active");
  const { call, deps } = await connect(tools, { prom, now });
  const all = await call("ops_alerts");
  assert.deepEqual((all.structuredContent?.items as Array<{ name: string; state: string }>).map((a) => [a.name, a.state]), [["ItDiskFull", "firing"], ["ItSoon", "pending"]]);
  assert.match(all.structuredContent?.summary as string, /^1 firing, 1 pending, 0 other \(sources: prometheus\)\. Grafana alerts not included/);
  const scoped = await call("ops_alerts", { server: "ovh-prod-1", stack: "shop", service: "shop_web" });
  assert.deepEqual((scoped.structuredContent?.items as Array<{ name: string }>).map((a) => a.name), ["ItDiskFull"]);

  const ctx = { ...deps, auth: { credentialId: "c", name: "n", kind: "token" as const, clientIp: "x" }, now: () => new Date(), signal: new AbortController().signal };
  const window = { from: new Date(Date.now() - 3600_000), to: new Date() };
  const registry = testRegistry();
  const alerts = await alertsSection.collect(ctx, registry.servers, window);
  assert.deepEqual(alerts.get("ovh-prod-1"), { firing: 1, names: ["ItDiskFull"] });
  const metrics = await metricsSection.collect(ctx, registry.servers, window);
  const prod = metrics.get("ovh-prod-1")!;
  near(prod.cpu_pct, 25, 2, "overview cpu");
  near(prod.ram_pct, 75, 0.1, "overview ram");
  near(prod.disk_max_pct, 50, 0.5, "overview disk");
});
