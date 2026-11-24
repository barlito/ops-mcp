import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromSeries } from "../metrics/PromClient";
import { connect, fakeProm, textOf } from "../test-support/mcp";
import { opsHostMetrics } from "./opsHostMetrics";

const s = (labels: Record<string, string>, values: number[]): PromSeries => ({ labels, points: values.map((v, i): [number, number] => [1780315200 - (values.length - i) * 75, v]) });

type Item = { metric: string; host: string | null; mountpoint?: string; last: number | null; days_until_full?: number | null; note?: string };

test("disks carry the days until full parsed from predict_linear, null when not filling", async () => {
  const queries: string[] = [];
  const { call } = await connect([opsHostMetrics], {
    prom: fakeProm({
      queryRange: async (q) => (q.includes("node_filesystem") ? [s({ host_name: "h1", mountpoint: "/" }, [50, 51]), s({ host_name: "h1", mountpoint: "/data" }, [10, 10])] : q.includes("node_load1") ? [s({ host_name: "h1" }, [0.5, 1.5])] : []),
      query: async (q) => (queries.push(q), [{ labels: { host_name: "h1", mountpoint: "/" }, value: 12.3456 }]),
    }),
  });
  const r = await call("ops_host_metrics", { server: "ovh-prod-1", host: 'h1"' });
  assert.ok(!r.isError);
  const items = r.structuredContent?.items as Item[];
  const disks = items.filter((i) => i.metric === "disk_used");
  assert.deepEqual(disks.map((d) => [d.host, d.mountpoint, d.days_until_full]), [["h1", "/", 12.3], ["h1", "/data", null]]);
  assert.equal(items.find((i) => i.metric === "load1")?.last, 1.5);
  const cpu = items.find((i) => i.metric === "cpu")!;
  assert.equal(cpu.last, null);
  assert.equal(cpu.host, 'h1"');
  assert.match(cpu.note ?? "", /no data/);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /predict_linear\(/);
  assert.match(queries[0]!, /host_name="h1\\""/);
  assert.match(textOf(r), /h1: \/ disk_used \(%\) .* days_until_full=12.3/);
  assert.match(textOf(r), /days_until_full=none/);
});

test("without any series every metric is null with a note and disks have no prediction", async () => {
  const { call } = await connect([opsHostMetrics]);
  const items = (await call("ops_host_metrics", { server: "ovh-prod-1" })).structuredContent?.items as Item[];
  assert.equal(items.length, 9);
  assert.equal(items.find((i) => i.metric === "disk_used")?.days_until_full, undefined);
});
