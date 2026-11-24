import { before, test } from "node:test";
import assert from "node:assert/strict";
import { LokiClient } from "../logs/LokiClient";
import { opsLogsContext } from "../tools/opsLogsContext";
import { opsLogsQuery } from "../tools/opsLogsQuery";
import { opsLogsQueryRaw } from "../tools/opsLogsQueryRaw";
import { opsLogsSummary } from "../tools/opsLogsSummary";
import { connect, textOf } from "../test-support/mcp";

const LOKI_URL = process.env.LOKI_URL ?? "http://loki:3100";
const SERVER = "ovh-prod-1";
const API = { server: SERVER, deployment_environment: "production", host_name: "node-1", service_namespace: "shop", service_name: "shop_api", container: "shop_api.1.abc" };
const WORKER = { ...API, service_name: "shop_worker", container: "shop_worker.1.def" };
const OTHER = { ...API, server: "lab", service_namespace: "tools", service_name: "tools_cron", container: "tools_cron.1.ghi" };

const baseMs = Date.now() - 10 * 60_000;
let tick = 0;
const stamp = (): string => String((BigInt(baseMs) + BigInt(tick++) * 1000n) * 1_000_000n);

const apiLines = [
  ...Array.from({ length: 12 }, (_, i) => `level=error msg="payment failed" order=${4000 + i * 7} user=${crypto.randomUUID()} ip=10.0.${i}.${i + 1}`),
  ...Array.from({ length: 6 }, (_, i) => `level=info msg="request served" path=/health took=${i}ms`),
  'level=error msg="cannot connect" dsn=postgres://shop:Sup3rSecretPw@db:5432/shop',
  "level=warn msg=\"slow query\" took=1800ms",
];
const workerLines = Array.from({ length: 3 }, (_, i) => `level=error msg="queue timeout after ${30 + i}s"`);
const otherLines = ["level=error msg=\"cron failed\" job=nightly"];

async function push(streams: Array<{ stream: Record<string, string>; lines: string[] }>): Promise<void> {
  const body = { streams: streams.map((s) => ({ stream: s.stream, values: s.lines.map((l) => [stamp(), l]) })) };
  const res = await fetch(`${LOKI_URL}/loki/api/v1/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, 204, await res.text());
}

async function waitReady(): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ok = await fetch(`${LOKI_URL}/ready`).then((r) => r.ok, () => false);
    if (ok) return;
    assert.ok(Date.now() < deadline, "Loki never became ready");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const loki = new LokiClient({ url: LOKI_URL });
const env = (r: { structuredContent?: unknown }) => r.structuredContent as { items: Array<Record<string, any>>; truncated: boolean; next_cursor?: string; summary: string };

before(async () => {
  await waitReady();
  await push([
    { stream: API, lines: apiLines },
    { stream: WORKER, lines: workerLines },
    { stream: OTHER, lines: otherLines },
  ]);
  // Loki serves recent writes straight from the ingester: wait until the last one is visible.
  for (let i = 0; i < 30; i++) {
    const d = await loki.queryRange({ query: '{server="lab"}', start: BigInt(baseMs - 60_000) * 1_000_000n, end: BigInt(Date.now() + 60_000) * 1_000_000n });
    if (d.type === "streams" && d.streams.length > 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.fail("pushed lines never became queryable");
});

test("ops_logs_summary groups the repeated error under one pattern, redacts, and stays under 4 KB", async () => {
  const { call } = await connect([opsLogsSummary], { loki, now: () => new Date() });
  const r = await call("ops_logs_summary", { since: "1h", server: SERVER });
  assert.ok(!r.isError, textOf(r));
  const { items } = env(r);
  const patterns = items.filter((i) => i.kind === "pattern");
  const payment = patterns.find((p) => p.count === 12)!;
  assert.ok(payment, JSON.stringify(patterns));
  assert.equal(payment.service, "shop_api");
  assert.equal(payment.pattern, 'level=error msg="payment failed" order=<n> user=<uuid> ip=<ip>');
  assert.ok(!JSON.stringify(items).includes("Sup3rSecretPw"));
  const counts = items.filter((i) => i.kind === "count").map((i) => `${i.service}/${i.level}/${i.count}`).sort();
  assert.deepEqual(counts, ["shop_api/error/13", "shop_api/warn/1", "shop_worker/error/3"]);
  assert.ok(Buffer.byteLength(JSON.stringify(r.structuredContent)) < 4096, `summary is ${Buffer.byteLength(JSON.stringify(r.structuredContent))} bytes`);
  assert.ok(Buffer.byteLength(textOf(r)) < 4096);
});

test("ops_logs_summary without a server spans every server", async () => {
  const { call } = await connect([opsLogsSummary], { loki, now: () => new Date() });
  const servers = new Set(env(await call("ops_logs_summary", { since: "1h" })).items.map((i) => i.server));
  assert.deepEqual([...servers].sort(), ["lab", SERVER]);
});

test("ops_logs_query filters, redacts DSN passwords and pages without loss", async () => {
  const { call } = await connect([opsLogsQuery], { loki, now: () => new Date() });
  const dsn = env(await call("ops_logs_query", { server: SERVER, contains: "cannot connect" }));
  assert.equal(dsn.items.length, 1);
  assert.equal(dsn.items[0]!.line, 'level=error msg="cannot connect" dsn=postgres://shop:[REDACTED]@db:5432/shop');
  assert.equal(dsn.items[0]!.level, "error");

  const re = env(await call("ops_logs_query", { server: SERVER, service: "shop_api", regex: "payment (failed|ok)", level: "error" }));
  assert.equal(re.items.length, 12);

  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const r = env(await call("ops_logs_query", { server: SERVER, service: "shop_api", limit: 7, max_bytes: 2048, direction: "forward", ...(cursor ? { cursor } : {}) }));
    seen.push(...r.items.map((i) => `${i.ts} ${i.line}`));
    cursor = r.next_cursor;
    pages++;
  } while (cursor && pages < 30);
  assert.equal(seen.length, apiLines.length);
  assert.equal(new Set(seen).size, apiLines.length);
  assert.deepEqual([...seen].sort(), seen);
  assert.ok(pages >= 3);
});

test("ops_logs_context returns the neighbours of a line", async () => {
  const { call } = await connect([opsLogsQuery, opsLogsContext], { loki, now: () => new Date() });
  const hit = env(await call("ops_logs_query", { server: SERVER, contains: "cannot connect" })).items[0]!;
  const r = env(await call("ops_logs_context", { server: SERVER, service: "shop_api", ts: hit.ts, before: 2, after: 1 }));
  assert.equal(r.items.length, 4);
  assert.equal(r.items[2]!.line, hit.line);
  assert.match(r.items[3]!.line, /slow query/);
});

test("ops_logs_query_raw runs log and metric queries", async () => {
  const { call } = await connect([opsLogsQueryRaw], { loki, now: () => new Date() });
  const logs = env(await call("ops_logs_query_raw", { logql: `{server="${SERVER}", service_name="shop_worker"} |= "timeout"`, limit: 2 }));
  assert.equal(logs.items.length, 2);
  assert.equal(logs.truncated, true);

  const metric = await call("ops_logs_query_raw", { logql: `sum by (service_name) (count_over_time({server="${SERVER}"} | detected_level="error" [1m]))`, since: "15m" });
  assert.ok(!metric.isError, textOf(metric));
  const series = env(metric).items.filter((i) => i.kind === "series");
  assert.ok(series.length >= 1 && series.every((s) => s.points.length <= 60));
});

test("a malformed LogQL query is query_rejected, not an internal error", async () => {
  const { call } = await connect([opsLogsQueryRaw], { loki, now: () => new Date() });
  assert.match(textOf(await call("ops_logs_query_raw", { logql: "{server=" })), /query_rejected/);
});
