import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromAlert } from "../metrics/PromClient";
import { connect, fakeProm, textOf } from "../test-support/mcp";
import { opsAlerts } from "./opsAlerts";

const alert = (labels: Record<string, string>, state = "firing", annotations: Record<string, string> = {}): PromAlert => ({ labels, annotations, state, activeAt: "2026-06-01T11:00:00Z", value: "1" });

const prom = fakeProm({
  alerts: async () => [
    alert({ alertname: "HighCpu", server: "ovh-prod-1", severity: "warning", service_namespace: "carapp", service_name: "carapp_php" }, "pending"),
    alert({ alertname: "DiskFull", server: "ovh-prod-1", severity: "critical" }, "firing", { summary: "Disk is 95% full" }),
    alert({ alertname: "Other", server: "lab" }),
  ],
});

type Item = { source: string; name: string; state: string };

test("without Grafana: Prometheus alerts, firing first, and the summary says Grafana is missing", async () => {
  const { call } = await connect([opsAlerts], { prom });
  const r = await call("ops_alerts");
  assert.ok(!r.isError);
  assert.deepEqual((r.structuredContent?.items as Item[]).map((i) => [i.source, i.name, i.state]), [["prometheus", "DiskFull", "firing"], ["prometheus", "Other", "firing"], ["prometheus", "HighCpu", "pending"]]);
  assert.equal(r.structuredContent?.summary, "2 firing, 1 pending, 0 other (sources: prometheus). Grafana alerts not included (GRAFANA_URL/GRAFANA_TOKEN not configured)");
  assert.match(textOf(r), /firing DiskFull \[critical\] \(prometheus\) since 2026-06-01T11:00:00Z: Disk is 95% full/);
});

test("with Grafana: both sources are merged, Normal alerts are dropped", async () => {
  const grafana = { alerts: async () => [alert({ alertname: "GrafanaRule", server: "ovh-prod-1" }, "Alerting"), alert({ alertname: "Quiet" }, "Normal"), alert({ alertname: "NoData", server: "ovh-prod-1" }, "NoData")] };
  const { call } = await connect([opsAlerts], { prom, grafana });
  const r = await call("ops_alerts", { server: "ovh-prod-1" });
  assert.deepEqual((r.structuredContent?.items as Item[]).map((i) => [i.source, i.name, i.state]), [["prometheus", "DiskFull", "firing"], ["grafana", "GrafanaRule", "firing"], ["prometheus", "HighCpu", "pending"], ["grafana", "NoData", "nodata"]]);
  assert.equal(r.structuredContent?.summary, "2 firing, 1 pending, 1 other (sources: prometheus, grafana)");
});

test("a failing Grafana only adds a note, a failing Prometheus is an error", async () => {
  const { ToolError } = await import("./contract");
  const grafana = { alerts: async () => Promise.reject(new ToolError("backend_unavailable", "Grafana is unreachable")) };
  const ok = await (await connect([opsAlerts], { prom, grafana })).call("ops_alerts");
  assert.ok(!ok.isError);
  assert.match(ok.structuredContent?.summary as string, /Grafana alerts unavailable: Grafana is unreachable/);
  const down = fakeProm({ alerts: async () => Promise.reject(new ToolError("backend_timeout", "Prometheus did not answer")) });
  assert.match(textOf(await (await connect([opsAlerts], { prom: down, grafana })).call("ops_alerts")), /^Error \[backend_timeout\]/);
});

test("filters match the alert labels; unknown servers are rejected", async () => {
  const { call } = await connect([opsAlerts], { prom });
  const byStack = (await call("ops_alerts", { stack: "carapp" })).structuredContent?.items as Item[];
  assert.deepEqual(byStack.map((i) => i.name), ["HighCpu"]);
  const byService = (await call("ops_alerts", { server: "ovh-prod-1", service: "carapp_php" })).structuredContent?.items as Item[];
  assert.deepEqual(byService.map((i) => i.name), ["HighCpu"]);
  assert.match(textOf(await call("ops_alerts", { server: "nope" })), /unknown_server/);
});
