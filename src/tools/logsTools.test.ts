import { test } from "node:test";
import assert from "node:assert/strict";
import { LokiClient } from "../logs/LokiClient";
import { FakeLoki, type FakeLine } from "../test-support/loki";
import { connect, textOf } from "../test-support/mcp";
import { logsSection } from "../overview/logsSection";
import { sampleEntries } from "../logs/fetch";
import { overviewTool } from "./opsOverview";
import { opsLogsContext } from "./opsLogsContext";
import { opsLogsQuery } from "./opsLogsQuery";
import { opsLogsQueryRaw } from "./opsLogsQueryRaw";
import { opsLogsSummary } from "./opsLogsSummary";
import { testRegistry } from "../test-support/fixtures";

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const ns = (agoMs: number): bigint => BigInt(NOW - agoMs) * 1_000_000n;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const lines = (n: number, mk: (i: number) => string = (i) => `line number ${i}`): FakeLine[] =>
  Array.from({ length: n }, (_, i) => ({ ns: ns((n - i) * 1000), line: mk(i) }));

const items = (r: { structuredContent?: unknown }) => (r.structuredContent as { items: Array<Record<string, any>> }).items;
const env = (r: { structuredContent?: unknown }) => r.structuredContent as { items: Array<Record<string, any>>; truncated: boolean; next_cursor?: string; summary: string; window: { from: string; to: string } };

test("ops_logs_query clamps the window to 24h and builds an escaped selector", async () => {
  const loki = new FakeLoki(lines(3));
  const { call } = await connect([opsLogsQuery], { loki });
  const r = await call("ops_logs_query", { server: "ovh-prod-1", service: "carapp_php", since: "7d", contains: 'a"b\\', level: "error" });
  assert.ok(!r.isError, textOf(r));
  const q = loki.ranges[0]!;
  assert.equal(q.query, '{server="ovh-prod-1", service_name="carapp_php"} |= "a\\"b\\\\" | detected_level=~"error"');
  assert.equal(q.end - q.start, BigInt(DAY) * 1_000_000n);
  assert.match(env(r).summary, /window capped at 24h/);
});

test("ops_logs_query redacts and truncates lines", async () => {
  const loki = new FakeLoki([{ ns: ns(1000), line: `connect postgres://u:pw123456@db/x ${"z".repeat(600)}` }]);
  const { call } = await connect([opsLogsQuery], { loki });
  const line = items(await call("ops_logs_query", {}))[0]!.line as string;
  assert.ok(!line.includes("pw123456"));
  assert.ok(line.length <= 400);
});

test("ops_logs_query pages without loss or duplicates, even when the byte cap cuts a page short", async () => {
  const all = lines(40, (i) => `entry ${String(i).padStart(3, "0")} ${"p".repeat(80)}`);
  for (const direction of ["backward", "forward"] as const) {
    const { call } = await connect([opsLogsQuery], { loki: new FakeLoki(all) });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await call("ops_logs_query", { limit: 15, direction, max_bytes: 2048, ...(cursor ? { cursor } : {}) });
      assert.ok(!r.isError, textOf(r));
      seen.push(...items(r).map((i) => i.line as string));
      cursor = env(r).next_cursor;
      pages++;
      assert.ok(pages < 50);
    } while (cursor);
    const expected = all.map((l) => l.line);
    assert.deepEqual(seen, direction === "forward" ? expected : [...expected].reverse());
    assert.ok(pages > 3, "the byte cap should have forced several pages");
  }
});

test("ops_logs_query: unknown server, bad cursor and control characters are rejected", async () => {
  const { call } = await connect([opsLogsQuery], { loki: new FakeLoki() });
  assert.match(textOf(await call("ops_logs_query", { server: "nope" })), /unknown_server/);
  assert.match(textOf(await call("ops_logs_query", { cursor: "!!" })), /invalid_cursor/);
  assert.match(textOf(await call("ops_logs_query", { service: 'a"} or {x="y' })), /plain name/);
  assert.match(textOf(await call("ops_logs_query", { contains: "a\u0000b" })), /invalid_param/);
  assert.match(textOf(await call("ops_logs_query", { regex: "(?=x)" })), /invalid_param/);
});

test("ops_logs_context returns lines around the instant, oldest first", async () => {
  const loki = new FakeLoki(lines(21)); // line i at NOW-(21-i)s
  const { call } = await connect([opsLogsContext], { loki });
  const at = new Date(NOW - 11_000).toISOString(); // line 10
  const r = await call("ops_logs_context", { server: "ovh-prod-1", service: "carapp_php", ts: at, before: 2, after: 3 });
  assert.ok(!r.isError, textOf(r));
  assert.deepEqual(items(r).map((i) => i.line), ["line number 8", "line number 9", "line number 10", "line number 11", "line number 12", "line number 13"]);
  assert.match(textOf(await call("ops_logs_context", { server: "ovh-prod-1", service: "x", ts: "yesterday" })), /ts must be an RFC 3339/);
});

test("ops_logs_summary: counts query, window caps, pattern grouping and size", async () => {
  const errs = lines(30, (i) => `level=error order ${1000 + i} failed for user ${crypto.randomUUID()} from 10.0.0.${i}`);
  const loki = new FakeLoki(errs);
  loki.instant = {
    type: "series",
    series: [
      { labels: { server: "ovh-prod-1", service_name: "carapp_php", detected_level: "error" }, points: [[1, "30"]] },
      { labels: { server: "ovh-prod-1", service_name: "carapp_php", detected_level: "warn" }, points: [[1, "4"]] },
      { labels: { server: "ovh-prod-1", service_name: "carapp_nginx", detected_level: "warn" }, points: [[1, "0"]] },
    ],
  };
  const { call } = await connect([opsLogsSummary], { loki });
  const r = await call("ops_logs_summary", { since: "10d" });
  assert.ok(!r.isError, textOf(r));
  assert.match(loki.instants[0]!.query, /^sum by \(server, service_name, detected_level\) \(count_over_time\(\{server=~"\.\+"\} \| detected_level=~"warn\|error\|critical\|fatal" \[604800s\]\)\)$/);
  const sample = loki.ranges[0]!;
  assert.equal(sample.end - sample.start, BigInt(DAY) * 1_000_000n);
  const out = items(r);
  const pattern = out.find((i) => i.kind === "pattern")!;
  assert.equal(pattern.count, 30);
  assert.equal(pattern.pattern, "level=error order <n> failed for user <uuid> from <ip>");
  assert.deepEqual(out.filter((i) => i.kind === "count").map((i) => [i.level, i.count]), [["error", 30], ["warn", 4]]);
  assert.match(env(r).summary, /34 lines at warn\+ across 1 service, 1 pattern \(window capped at 7d, patterns from the last 24h\)/);
  assert.ok(Buffer.byteLength(JSON.stringify(r.structuredContent)) < 4096);
});

test("ops_logs_summary pages the sample past Loki's 1000-line page", async () => {
  const loki = new FakeLoki(lines(2300, (i) => `level=error boom ${i}`));
  const { call } = await connect([opsLogsSummary], { loki });
  const r = await call("ops_logs_summary", { since: "24h" });
  assert.equal(items(r).find((i) => i.kind === "pattern")!.count, 2300);
  assert.equal(loki.ranges.length, 3);
});

test("ops_logs_query_raw: log queries are capped to 24h, metric queries to 7d and 20 series x 60 points", async () => {
  const loki = new FakeLoki(lines(5));
  loki.instant = { type: "series", series: [] };
  const { call } = await connect([opsLogsQueryRaw], { loki });
  const logs = await call("ops_logs_query_raw", { logql: '{server="ovh-prod-1"} |= "x"', since: "7d", limit: 2 });
  assert.equal(items(logs).length, 2);
  assert.equal(env(logs).truncated, true);
  assert.equal(loki.ranges[0]!.end - loki.ranges[0]!.start, BigInt(DAY) * 1_000_000n);

  const series = Array.from({ length: 25 }, (_, i) => ({ labels: { n: String(i) }, points: Array.from({ length: 80 }, (_, p): [number, string] => [p, "1"]) }));
  const metric: typeof loki.queryRange = async (p) => {
    loki.ranges.push(p);
    return { type: "series", series };
  };
  loki.queryRange = metric;
  const m = await call("ops_logs_query_raw", { logql: "sum by (n) (rate({server=~\".+\"}[5m]))", since: "7d", max_bytes: 48 * 1024 });
  const last = loki.ranges.at(-1)!;
  assert.equal(last.end - last.start, BigInt(7 * DAY) * 1_000_000n);
  assert.equal(last.step, 10080);
  assert.equal(items(m).length, 20);
  assert.equal(items(m)[0]!.points.length, 60);
  assert.equal(env(m).truncated, true);
});

test("ops_logs_query_raw rejects queries over 2000 characters", async () => {
  const { call } = await connect([opsLogsQueryRaw], { loki: new FakeLoki() });
  const r = await call("ops_logs_query_raw", { logql: `{server="a"} |= "${"x".repeat(2000)}"` });
  assert.ok(r.isError);
  assert.match(textOf(r), /2000/);
});

test("logs overview section: top error patterns per server, errors degrade to a note", async () => {
  const loki = new FakeLoki(lines(6, (i) => `level=error db down after ${i}s`));
  const { deps } = await connect([], { loki });
  const ctx = { ...deps, signal: new AbortController().signal, auth: { credentialId: "c", name: "n", kind: "token" as const, clientIp: "x" }, now: () => new Date(NOW) };
  const servers = testRegistry().servers;
  const parts = await logsSection.collect(ctx, servers, { from: new Date(NOW - HOUR), to: new Date(NOW) });
  assert.deepEqual(parts.get("ovh-prod-1")!.patterns.map((p) => [p.service, p.count, p.pattern]), [["carapp_php", 6, "level=error db down after <n>s"]]);
  assert.match(logsSection.summarize(parts), /ovh-prod-1: 1 error pattern, top carapp_php x6/);

  const broken = await logsSection.collect({ ...ctx, loki: new LokiClient({ url: "http://127.0.0.1:1" }) }, servers, { from: new Date(NOW - HOUR), to: new Date(NOW) });
  assert.match(broken.get("lab")!.error ?? "", /unreachable/);
});

test("ops_overview carries the logs part of every server", async () => {
  const loki = new FakeLoki(lines(4, (i) => `level=error cache miss ${i}`));
  const { call } = await connect([overviewTool([logsSection])], { loki });
  const r = await call("ops_overview");
  assert.ok(!r.isError, textOf(r));
  const first = items(r)[0]!;
  assert.equal(first.server, "ovh-prod-1");
  assert.deepEqual(first.logs.patterns.map((p: { count: number; pattern: string }) => [p.count, p.pattern]), [[4, "level=error cache miss <n>"]]);
  assert.match(env(r).summary, /ovh-prod-1: 1 error pattern/);
});

test("ops_logs_query: lines sharing a timestamp are neither lost nor repeated across pages", async () => {
  const same = Array.from({ length: 23 }, (_, i): FakeLine => ({ ns: ns(5000), line: `same ts ${String(i).padStart(2, "0")}` }));
  const all = [...lines(5), ...same, { ns: ns(100), line: "newest" }];
  for (const direction of ["backward", "forward"] as const) {
    const { call } = await connect([opsLogsQuery], { loki: new FakeLoki(all) });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await call("ops_logs_query", { limit: 4, direction, ...(cursor ? { cursor } : {}) });
      assert.ok(!r.isError, textOf(r));
      seen.push(...items(r).map((i) => i.line as string));
      cursor = env(r).next_cursor;
    } while (cursor && ++pages < 40);
    assert.equal(seen.length, all.length);
    assert.equal(new Set(seen).size, all.length);
  }
});

test("ops_logs_query: a page always keeps at least one line, even with a long line and the smallest max_bytes", async () => {
  const loki = new FakeLoki([{ ns: ns(2000), line: '"quoted" \\ '.repeat(60) }, { ns: ns(1000), line: "second" }]);
  const { call } = await connect([opsLogsQuery], { loki });
  const r = await call("ops_logs_query", { server: "ovh-prod-1", service: "carapp_php", direction: "forward", max_bytes: 1024 });
  assert.ok(!r.isError, textOf(r));
  assert.ok(items(r).length >= 1);
  assert.ok(Buffer.byteLength(JSON.stringify(r.structuredContent)) <= 1024);
});

test("ops_logs_query: a forged cursor cannot widen the 24h window", async () => {
  const loki = new FakeLoki(lines(3));
  const { call } = await connect([opsLogsQuery], { loki });
  const cursor = (nsValue: bigint) => Buffer.from(JSON.stringify({ ns: String(nsValue), seen: 0 })).toString("base64url");
  await call("ops_logs_query", { since: "7d", cursor: cursor(ns(7 * DAY - 1000)), direction: "forward" });
  assert.ok(loki.ranges[0]!.start >= ns(DAY));
  // Backward from before the window: nothing to ask Loki.
  const before = loki.ranges.length;
  const r = await call("ops_logs_query", { since: "7d", cursor: cursor(ns(3 * DAY)), direction: "backward" });
  assert.equal(items(r).length, 0);
  assert.equal(loki.ranges.length, before);
});

test("ops_logs_query_raw returns only the known stream labels of log lines and masks sensitive metric labels", async () => {
  const loki = new FakeLoki([{ ns: ns(1000), line: "x", labels: { password: "hunter2", user: "bob", container: "c1" } }]);
  const { call } = await connect([opsLogsQueryRaw], { loki });
  const logs = await call("ops_logs_query_raw", { logql: '{server="ovh-prod-1"} | json' });
  assert.deepEqual(items(logs)[0]!.labels, { server: "ovh-prod-1", service_name: "carapp_php", container: "c1", detected_level: "error" });
  assert.ok(!JSON.stringify(logs).includes("hunter2"));

  loki.queryRange = async () => ({ type: "series", series: [{ labels: { password: "hunter2", api_key: "k", user: "bob", dsn: "postgres://u:pw@h/db", long: "z".repeat(1000) }, points: [[1, "1"]] }] });
  const metric = await call("ops_logs_query_raw", { logql: "sum by (password, user) (count_over_time({server=~\".+\"} | json [5m]))" });
  const labels = items(metric)[0]!.labels;
  assert.deepEqual([labels.password, labels.api_key, labels.user], ["[REDACTED]", "[REDACTED]", "bob"]);
  assert.ok(!JSON.stringify(metric).includes("hunter2") && !JSON.stringify(metric).includes(":pw@"));
  assert.ok(labels.long!.length <= 200);

  loki.queryRange = async () => ({ type: "series", series: [{ labels: { x: `ghp_${"a".repeat(36)}`, y: "token=abc12345", z: "fine" }, points: [[1, "1"]] }] });
  const neutral = items(await call("ops_logs_query_raw", { logql: 'sum by (x, y, z) (count_over_time({server=~".+"} [5m]))' }))[0]!.labels;
  assert.deepEqual(neutral, { x: "[REDACTED]", y: "[REDACTED]", z: "fine" });
});

test("ops_logs_query_raw refuses line_format/label_format and long lookbacks, ignores comments and string contents", async () => {
  const loki = new FakeLoki(lines(2));
  const { call } = await connect([opsLogsQueryRaw], { loki });
  for (const bad of ['{a="b"} | line_format "{{.x}}"', '{a="b"} | label_format x=y', '{a="b"} # c\n | line_format "x"', 'rate({a="b"}[8d])', 'rate({a="b"}[1d] offset 2w)', 'sum_over_time({a="b"} | unwrap x [14d:1h])', 'sum by (x) (count_over_time({a="b"} | regexp "token=(?P<x>\\\\S+)" [5m]))', 'sum by (x) (count_over_time({a="b"} | pattern "<_> <x>" [5m]))']) {
    const r = await call("ops_logs_query_raw", { logql: bad });
    assert.match(textOf(r), /invalid_param/, bad);
  }
  assert.equal(loki.ranges.length, 0);
  // A comment must not turn a log query into a metric one, and strings may contain the words.
  const ok = await call("ops_logs_query_raw", { logql: '# note\n{server="ovh-prod-1"} |= "line_format [30d] #x"', since: "7d" });
  assert.ok(!ok.isError, textOf(ok));
  assert.equal(loki.ranges[0]!.query, '\n{server="ovh-prod-1"} |= "line_format [30d] #x"');
  assert.equal(loki.ranges[0]!.end - loki.ranges[0]!.start, BigInt(DAY) * 1_000_000n);
  assert.ok((await call("ops_logs_query_raw", { logql: 'rate({a="b"}[7d])' })).isError !== true);
  assert.ok((await call("ops_logs_query_raw", { logql: '{a="b"} | regexp "x=(?P<x>\\\\S+)"' })).isError !== true);
});

test("sampling stops paging when its time budget is spent", async () => {
  const loki = new FakeLoki(lines(2500, (i) => `level=error boom ${i}`));
  const got = await sampleEntries(loki, "q", 0n, ns(0) + 1n, 5000, 0);
  assert.equal(got.length, 1000);
  assert.equal(loki.ranges.length, 1);
});
