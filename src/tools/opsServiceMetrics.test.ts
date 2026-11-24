import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromSeries } from "../metrics/PromClient";
import { connect, fakeProm, textOf } from "../test-support/mcp";
import { opsServiceMetrics } from "./opsServiceMetrics";

const series = (values: number[]): PromSeries => ({ labels: {}, points: values.map((v, i): [number, number] => [1000 + i * 75, v]) });
const ramp = (n: number) => Array.from({ length: n }, (_, i) => i);

test("returns stats and a sparkline per metric, null with a note when a series is missing", async () => {
  const { call } = await connect([opsServiceMetrics], {
    prom: fakeProm({
      queryRange: async (q) => (q.includes("container_cpu_usage_seconds_total") ? [series(ramp(49))] : []),
      query: async () => [{ labels: {}, value: 2 }],
    }),
  });
  const r = await call("ops_service_metrics", { server: "ovh-prod-1", service: "carapp_php" });
  assert.ok(!r.isError);
  const items = r.structuredContent?.items as Array<{ metric: string; last: number | null; max: number | null; points: number[]; sparkline: string; note?: string }>;
  assert.deepEqual(items.map((i) => i.metric), ["cpu", "memory_working_set", "memory_of_limit", "container_starts", "network_rx", "network_tx", "traefik_requests", "traefik_5xx", "traefik_p95_latency"]);
  const cpu = items[0]!;
  assert.equal(cpu.max, 48);
  assert.equal(cpu.last, 48);
  assert.ok(cpu.points.length <= 30);
  assert.equal(cpu.sparkline.length, cpu.points.length);
  assert.equal(items[1]!.last, null);
  assert.match(items[1]!.note ?? "", /no data/);
  assert.equal(items[3]!.last, 2);
  assert.equal(r.structuredContent?.summary, "carapp_php on ovh-prod-1: 2 of 9 metrics have data, step 75s");
  assert.match(textOf(r), /^cpu \(cores\) [▁-█]+ min=0 max=48 avg=24 last=48$/m);
  assert.match(textOf(r), /^memory_working_set \(MiB\) min=n\/a max=n\/a avg=n\/a last=n\/a \[no data/m);
});

test("every query is scoped by escaped labels and Traefik is matched on service and stack", async () => {
  const seen: string[] = [];
  const { call } = await connect([opsServiceMetrics], {
    prom: fakeProm({
      queryRange: async (q) => (seen.push(q), []),
      query: async (q) => (seen.push(q), []),
    }),
  });
  await call("ops_service_metrics", { server: "ovh-prod-1", service: 'carapp_php"} or up{a="' });
  assert.equal(seen.length, 9);
  for (const q of seen.filter((q) => !q.includes("traefik"))) assert.match(q, /server="ovh-prod-1",service_name="carapp_php\\"\} or up\{a=\\""/);
  const traefik = seen.filter((q) => q.includes("traefik_service"));
  assert.equal(traefik.length, 3);
  for (const q of traefik) assert.ok(q.includes(String.raw`service=~"(carapp_php\\\"\\} or up\\{a\\=\\\"|carapp)@.+"`), q);
});

test("a service without underscore is matched on its own name only", async () => {
  const seen: string[] = [];
  const { call } = await connect([opsServiceMetrics], { prom: fakeProm({ queryRange: async (q) => (seen.push(q), []) }) });
  await call("ops_service_metrics", { server: "ovh-prod-1", service: "traefik" });
  assert.ok(seen.some((q) => q.includes('service=~"(traefik)@.+"')));
});

test("the window is clamped to 7 days and the step stays within 60 points", async () => {
  const steps: number[] = [];
  const { call } = await connect([opsServiceMetrics], { prom: fakeProm({ queryRange: async (_q, w, step) => (steps.push(step), (w.to.getTime() - w.from.getTime()) / 1000 / step + 1 <= 60 ? [] : assert.fail("too many points")) }) });
  const r = await call("ops_service_metrics", { server: "ovh-prod-1", service: "a_b", since: "30d" });
  assert.match(r.structuredContent?.summary as string, /window clamped to 7d/);
  assert.equal((r.structuredContent?.window as { from: string }).from, "2026-05-25T12:00:00.000Z");
  assert.ok(steps.every((s) => s === 10260));
});

test("unknown server and missing parameters are errors", async () => {
  const { call } = await connect([opsServiceMetrics]);
  const unknown = await call("ops_service_metrics", { server: "nope", service: "a_b" });
  assert.match(textOf(unknown), /unknown_server/);
  assert.ok((await call("ops_service_metrics", { server: "ovh-prod-1" })).isError);
});
