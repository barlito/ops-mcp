import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "../tools/contract";
import { testRegistry } from "../test-support/fixtures";
import { fakeProm, TEST_AUTH } from "../test-support/mcp";
import { OVERVIEW_SECTIONS } from "./index";
import { alertsSection } from "./alertsSection";
import { metricsSection } from "./metricsSection";

const window = { from: new Date("2026-06-01T11:00:00Z"), to: new Date("2026-06-01T12:00:00Z") };
const registry = testRegistry();
const ctx = (over: Partial<ToolContext>): ToolContext => ({ registry, cluster: () => ({ info: async () => ({ reachable: true, swarm: true }) }), audit: undefined as never, prom: fakeProm(), auth: TEST_AUTH, now: () => window.to, ...over });

test("both sections are registered", () => {
  assert.deepEqual(OVERVIEW_SECTIONS.map((s) => s.name), ["metrics", "alerts"]);
});

test("metrics: cpu, ram and the fullest disk per server, one failing server does not hide the others", async () => {
  const prom = fakeProm({
    query: async (q) => {
      if (q.includes('server="lab"')) throw new Error("boom http://user:pw@x");
      return [{ labels: {}, value: q.startsWith("avg(100 * (1 - avg by") ? 12.34 : q.startsWith("max(") ? 91.26 : 55 }];
    },
  });
  const parts = await metricsSection.collect(ctx({ prom }), registry.servers, window);
  assert.deepEqual(parts.get("ovh-prod-1"), { cpu_pct: 12.3, ram_pct: 55, disk_max_pct: 91.3 });
  assert.deepEqual(parts.get("lab"), { cpu_pct: null, ram_pct: null, disk_max_pct: null, error: "boom http://***@x" });
  assert.equal(metricsSection.summarize(parts), "ovh-prod-1: cpu 12.3%, ram 55%, disk max 91.3%; lab: cpu n/a, ram n/a, disk max n/a (boom http://***@x)");
  for (const p of parts.values()) assert.ok(metricsSection.partSchema.safeParse(p).success);
});

test("metrics: no series gives null headlines", async () => {
  const parts = await metricsSection.collect(ctx({}), registry.servers.slice(0, 1), window);
  assert.deepEqual(parts.get("ovh-prod-1"), { cpu_pct: null, ram_pct: null, disk_max_pct: null });
});

test("alerts: firing count and distinct names per server", async () => {
  const a = (alertname: string, server: string, state = "firing") => ({ labels: { alertname, server }, annotations: {}, state });
  const prom = fakeProm({ alerts: async () => [a("DiskFull", "ovh-prod-1"), a("DiskFull", "ovh-prod-1"), a("Cpu", "ovh-prod-1"), a("Soon", "ovh-prod-1", "pending"), a("Down", "lab")] });
  const parts = await alertsSection.collect(ctx({ prom }), registry.servers, window);
  assert.deepEqual(parts.get("ovh-prod-1"), { firing: 3, names: ["Cpu", "DiskFull"] });
  assert.deepEqual(parts.get("lab"), { firing: 1, names: ["Down"] });
  assert.equal(alertsSection.summarize(parts), "ovh-prod-1: 3 firing (Cpu, DiskFull); lab: 1 firing (Down)");
  const none = await alertsSection.collect(ctx({}), registry.servers, window);
  assert.equal(alertsSection.summarize(none), "ovh-prod-1: no firing alert; lab: no firing alert");
});
