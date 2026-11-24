import { test } from "node:test";
import assert from "node:assert/strict";
import type { PromSeries } from "../metrics/PromClient";
import { connect, fakeProm, textOf } from "../test-support/mcp";
import { opsMetricsQuery } from "./opsMetricsQuery";

const many = (n: number, points: number): PromSeries[] =>
  Array.from({ length: n }, (_, i) => ({ labels: { i: String(i) }, points: Array.from({ length: points }, (_, p): [number, number] => [p, p]) }));

test("caps the result at 20 series and 60 points", async () => {
  const { call } = await connect([opsMetricsQuery], { prom: fakeProm({ queryRange: async () => many(25, 80) }) });
  const r = await call("ops_metrics_query", { promql: "up", max_bytes: 48 * 1024 });
  assert.ok(!r.isError);
  const items = r.structuredContent?.items as Array<{ samples: unknown[]; sparkline: string }>;
  assert.equal(items.length, 20);
  assert.ok(items.every((i) => i.samples.length === 60 && i.sparkline.length === 30));
  assert.equal(r.structuredContent?.truncated, true);
  assert.match(r.structuredContent?.summary as string, /25 series.*showing the first 20/);
});

test("the step is raised to keep 60 points and the request is passed through unchanged", async () => {
  let call_: { q: string; step: number } | undefined;
  const { call } = await connect([opsMetricsQuery], { prom: fakeProm({ queryRange: async (q, _w, step) => ((call_ = { q, step }), []) }) });
  const r = await call("ops_metrics_query", { promql: 'rate(x{a="b"}[5m])', since: "7d", step: "15s" });
  assert.deepEqual(call_, { q: 'rate(x{a="b"}[5m])', step: 10260 });
  assert.match(r.structuredContent?.summary as string, /step raised from 15s to 10260s/);
  await call("ops_metrics_query", { promql: "up", since: "1h", step: "5m" });
  assert.equal(call_?.step, 300);
});

test("a window beyond 7 days is clamped; bad input is rejected", async () => {
  const { call } = await connect([opsMetricsQuery]);
  assert.match((await call("ops_metrics_query", { promql: "up", since: "30d" })).structuredContent?.summary as string, /window clamped to 7d/);
  assert.ok((await call("ops_metrics_query", { promql: "x".repeat(2001) })).isError);
  assert.ok((await call("ops_metrics_query", { promql: "" })).isError);
  assert.ok((await call("ops_metrics_query", { promql: "up", step: "soon" })).isError);
});

test("backend failures come back as coded errors", async () => {
  const { ToolError } = await import("./contract");
  const { call } = await connect([opsMetricsQuery], { prom: fakeProm({ queryRange: async () => Promise.reject(new ToolError("query_rejected", "Prometheus rejected the query: parse error")) }) });
  assert.match(textOf(await call("ops_metrics_query", { promql: "x(" })), /^Error \[query_rejected\]/);
});
