import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "../tools/contract";
import { testRegistry } from "../test-support/fixtures";
import { connect, fakeProm, TEST_AUTH } from "../test-support/mcp";
import { overviewTool } from "../tools/opsOverview";
import { OVERVIEW_SECTIONS } from "./index";
import { alertsSection } from "./alertsSection";
import { metricsSection } from "./metricsSection";

const window = { from: new Date("2026-06-01T11:00:00Z"), to: new Date("2026-06-01T12:00:00Z") };
const registry = testRegistry();
const ctx = async (over: Partial<ToolContext>): Promise<ToolContext> => ({ ...(await connect([])).deps, auth: TEST_AUTH, now: () => window.to, signal: new AbortController().signal, ...over });

test("both sections are registered", () => {
  assert.deepEqual(OVERVIEW_SECTIONS.map((s) => s.name), ["swarm", "logs", "metrics", "alerts"]);
});

test("metrics: cpu, ram and the fullest disk per server, one failing server does not hide the others", async () => {
  const prom = fakeProm({
    query: async (q) => {
      if (q.includes('server="lab"')) throw new Error("boom http://user:pw@x");
      return [{ labels: {}, value: q.startsWith("avg(100 * (1 - avg by") ? 12.34 : q.startsWith("max(") ? 91.26 : 55 }];
    },
  });
  const parts = await metricsSection.collect(await ctx({ prom }), registry.servers, window);
  assert.deepEqual(parts.get("ovh-prod-1"), { cpu_pct: 12.3, ram_pct: 55, disk_max_pct: 91.3 });
  assert.deepEqual(parts.get("lab"), { cpu_pct: null, ram_pct: null, disk_max_pct: null, error: "boom http://***@x" });
  assert.equal(metricsSection.summarize(parts), "ovh-prod-1: cpu 12.3%, ram 55%, disk max 91.3%; lab: cpu n/a, ram n/a, disk max n/a (boom http://***@x)");
  for (const p of parts.values()) assert.ok(metricsSection.partSchema.safeParse(p).success);
});

test("metrics: no series gives null headlines", async () => {
  const parts = await metricsSection.collect(await ctx({}), registry.servers.slice(0, 1), window);
  assert.deepEqual(parts.get("ovh-prod-1"), { cpu_pct: null, ram_pct: null, disk_max_pct: null });
});

test("alerts: firing count and distinct names per server", async () => {
  const a = (alertname: string, server: string, state = "firing") => ({ labels: { alertname, server }, annotations: {}, state });
  const prom = fakeProm({ alerts: async () => [a("DiskFull", "ovh-prod-1"), a("DiskFull", "ovh-prod-1"), a("Cpu", "ovh-prod-1"), a("Soon", "ovh-prod-1", "pending"), a("Down", "lab")] });
  const parts = await alertsSection.collect(await ctx({ prom }), registry.servers, window);
  const NOTE = "Grafana alerts not included (Grafana not configured)";
  assert.deepEqual(parts.get("ovh-prod-1"), { firing: 3, names: ["Cpu", "DiskFull"], firing_without_server: 0, names_without_server: [], notes: [NOTE], rules_configured: true });
  assert.deepEqual(parts.get("lab"), { firing: 1, names: ["Down"], firing_without_server: 0, names_without_server: [], notes: [NOTE], rules_configured: true });
  assert.equal(alertsSection.summarize(parts), `ovh-prod-1: 3 firing (Cpu, DiskFull); lab: 1 firing (Down); ${NOTE}`);
  const none = await alertsSection.collect(await ctx({}), registry.servers, window);
  assert.equal(alertsSection.summarize(none), `ovh-prod-1: no firing alert; lab: no firing alert; ${NOTE}`);
});

test("ops_overview shows the metrics and alerts parts", async () => {
  const prom = fakeProm({
    query: async () => [{ labels: {}, value: 42 }],
    alerts: async () => [{ labels: { alertname: "DiskFull", server: "ovh-prod-1" }, annotations: {}, state: "firing" }],
  });
  const { call } = await connect([overviewTool([metricsSection, alertsSection])], { prom });
  const r = await call("ops_overview", { server: "ovh-prod-1" });
  assert.ok(!r.isError);
  const item = (r.structuredContent?.items as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(item.metrics, { cpu_pct: 42, ram_pct: 42, disk_max_pct: 42 });
  assert.deepEqual(item.alerts, { firing: 1, names: ["DiskFull"], firing_without_server: 0, names_without_server: [], notes: ["Grafana alerts not included (Grafana not configured)"], rules_configured: true });
});

test("alerts: unattributed firing alerts and source failures are never reported as all clear", async () => {
  const { ToolError } = await import("../tools/contract");
  const prom = fakeProm({ alerts: async () => [{ labels: { alertname: "Global" }, annotations: {}, state: "firing" }] });
  const grafana = { alerts: async () => Promise.reject(new ToolError("backend_unavailable", "Grafana is unreachable")) };
  const parts = await alertsSection.collect(await ctx({ prom, grafana }), registry.servers.slice(0, 1), window);
  const part = parts.get("ovh-prod-1")!;
  assert.equal(part.firing, 0);
  assert.deepEqual([part.firing_without_server, part.names_without_server], [1, ["Global"]]);
  assert.equal(alertsSection.summarize(parts), "ovh-prod-1: none attributed to this server; 1 firing without server label (Global); Grafana alerts unavailable: Grafana is unreachable");
  const failing = await alertsSection.collect(await ctx({ grafana }), registry.servers.slice(0, 1), window);
  assert.match(alertsSection.summarize(failing), /^ovh-prod-1: none attributed to this server; Grafana alerts unavailable/);
});

test("alerts: no rule group means no alert rules configured, not all clear", async () => {
  const parts = await alertsSection.collect(await ctx({ prom: fakeProm({ hasRules: async () => false }) }), registry.servers, window);
  assert.equal(parts.get("lab")?.rules_configured, false);
  assert.match(alertsSection.summarize(parts), /^ovh-prod-1: no alert rules configured; lab: no alert rules configured; /);
});
