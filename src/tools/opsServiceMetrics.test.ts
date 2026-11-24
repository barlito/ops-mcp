import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromSeries } from "../metrics/PromClient";
import { connect, fakeProm, textOf } from "../test-support/mcp";
import { opsServiceMetrics } from "./opsServiceMetrics";

const series = (values: number[]): PromSeries => ({ labels: {}, points: values.map((v, i): [number, number] => [1780315200 - (values.length - i) * 75, v]) });
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

test("every query is scoped by label and Traefik is matched on service and stack", async () => {
  const seen: string[] = [];
  const { call } = await connect([opsServiceMetrics], {
    prom: fakeProm({
      queryRange: async (q) => (seen.push(q), []),
      query: async (q) => (seen.push(q), []),
    }),
  });
  await call("ops_service_metrics", { server: "ovh-prod-1", service: "carapp_php" });
  assert.equal(seen.length, 10);
  for (const q of seen.filter((q) => !q.includes("traefik"))) assert.match(q, /server="ovh-prod-1",service_name="carapp_php"/);
  const traefik = seen.filter((q) => q.includes("traefik_service"));
  assert.equal(traefik.length, 4);
  for (const q of traefik) assert.match(q, /service=~"(?:[^"\\]|\\.)*@\.\+"[,}]/, q);
});

test("a service without underscore is matched on its own name and the auto-generated variant only", async () => {
  const seen: string[] = [];
  const { call } = await connect([opsServiceMetrics], { prom: fakeProm({ queryRange: async (q) => (seen.push(q), []) }) });
  await call("ops_service_metrics", { server: "ovh-prod-1", service: "traefik" });
  assert.ok(seen.some((q) => q.includes('service=~"(traefik)@.+"')));
  seen.length = 0;
  await call("ops_service_metrics", { server: "ovh-prod-1", service: "carapp_php" });
  assert.ok(seen.some((q) => q.includes(String.raw`service=~"(carapp_php|carapp|carapp\\-php)@.+"`)));
});

test("a note says when only the stack-level Traefik service matched", async () => {
  const withTraffic = (matched: string[]) =>
    fakeProm({
      queryRange: async (q) => (q.includes("traefik") ? [series([1, 2, 3])] : []),
      query: async (q) => (q.startsWith("count by (service)") ? matched.map((service) => ({ labels: { service }, value: 1 })) : []),
    });
  const run = async (matched: string[]) => {
    const { call } = await connect([opsServiceMetrics], { prom: withTraffic(matched) });
    return (await call("ops_service_metrics", { server: "ovh-prod-1", service: "carapp_php" })).structuredContent?.items as Array<{ metric: string; note?: string }>;
  };
  const stackLevel = await run(["carapp@swarm"]);
  assert.match(stackLevel.find((i) => i.metric === "traefik_requests")?.note ?? "", /carapp@swarm is shared by the whole stack/);
  assert.equal(stackLevel.find((i) => i.metric === "cpu")?.note, "no data for this metric");
  const exact = await run(["carapp_php@swarm"]);
  assert.equal(exact.find((i) => i.metric === "traefik_requests")?.note, undefined);
});

test("a stale last sample is flagged", async () => {
  const old = { labels: {}, points: [[1, 1], [2, 2]] as Array<[number, number]> };
  const { call } = await connect([opsServiceMetrics], { prom: fakeProm({ queryRange: async (q) => (q.includes("container_cpu") ? [old] : []) }) });
  const cpu = ((await call("ops_service_metrics", { server: "ovh-prod-1", service: "a_b" })).structuredContent?.items as Array<{ metric: string; note?: string }>)[0]!;
  assert.match(cpu.note ?? "", /older than the end of the window/);
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

test("a service name that is not a plain name is refused before any query", async () => {
  let queried = false;
  const { call } = await connect([opsServiceMetrics], { prom: fakeProm({ queryRange: async () => ((queried = true), []) }) });
  assert.ok((await call("ops_service_metrics", { server: "ovh-prod-1", service: 'carapp_php"} or up{a="' })).isError);
  assert.equal(queried, false);
});
