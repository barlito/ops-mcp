import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { connect, textOf } from "../test-support/mcp";
import { testRegistry } from "../test-support/fixtures";
import {
  buildResult,
  clampWindow,
  decodeCursor,
  defineTool,
  DEFAULT_MAX_BYTES,
  encodeCursor,
  envelopeSchema,
  limitParam,
  MAX_MAX_BYTES,
  resolveMaxBytes,
  resolveServers,
  resolveWindow,
  scopeShape,
  ToolError,
  type ToolGuard,
  UNTRUSTED_DATA_NOTICE,
} from "./contract";
import { TOOLS } from "./index";
import { RateLimiter } from "../platform/rateLimit";
import { SlotLimiter } from "../platform/slotLimiter";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const iso = (d: Date): string => d.toISOString();

// ---- window ----------------------------------------------------------------

test("resolveWindow defaults to the last hour", () => {
  const w = resolveWindow({}, NOW);
  assert.equal(iso(w.to), "2026-06-01T12:00:00.000Z");
  assert.equal(iso(w.from), "2026-06-01T11:00:00.000Z");
});

test("resolveWindow understands durations counted back from until", () => {
  for (const [since, ms] of [["15m", 15 * 60_000], ["1h", 3_600_000], ["24h", 86_400_000], ["7d", 7 * 86_400_000]] as const) {
    const w = resolveWindow({ since }, NOW);
    assert.equal(w.to.getTime() - w.from.getTime(), ms, since);
  }
  const w = resolveWindow({ since: "2h", until: "2026-05-30T00:00:00Z" }, NOW);
  assert.equal(iso(w.to), "2026-05-30T00:00:00.000Z");
  assert.equal(iso(w.from), "2026-05-29T22:00:00.000Z");
});

test("resolveWindow accepts RFC 3339 instants with offsets", () => {
  const w = resolveWindow({ since: "2026-06-01T10:00:00+02:00", until: "2026-06-01T11:00:00Z" }, NOW);
  assert.equal(iso(w.from), "2026-06-01T08:00:00.000Z");
  assert.equal(iso(w.to), "2026-06-01T11:00:00.000Z");
});

test("resolveWindow rejects empty, inverted and malformed windows", () => {
  const code = (p: Parameters<typeof resolveWindow>[0]): string | undefined => {
    try {
      resolveWindow(p, NOW);
    } catch (err) {
      return err instanceof ToolError ? err.code : "other";
    }
  };
  assert.equal(code({ since: "2026-06-01T13:00:00Z" }), "invalid_window");
  assert.equal(code({ since: "2026-06-01T12:00:00Z" }), "invalid_window");
  assert.equal(code({ since: "1h", until: "2026-06-01T00:00:00Z", }), undefined);
  assert.equal(code({ since: "2026-06-02T00:00:00Z", until: "2026-06-01T00:00:00Z" }), "invalid_window");
  assert.equal(code({ since: "yesterday" }), "invalid_window");
  assert.equal(code({ until: "2026-06-01" }), "invalid_window");
  assert.equal(code({ since: "2026-13-45T00:00:00Z" }), "invalid_window");
});

test("scope schema rejects malformed since/until before any handler runs", () => {
  const s = z.object(scopeShape);
  assert.ok(s.safeParse({ since: "15m", until: "2026-06-01T12:00:00Z" }).success);
  assert.ok(s.safeParse({ since: "2026-06-01T12:00:00.5+01:00" }).success);
  for (const bad of ["1w", "h", "-1h", "1000h", "1 h", "2026-06-01"]) assert.ok(!s.safeParse({ since: bad }).success, bad);
  assert.ok(!s.safeParse({ until: "1h" }).success);
});

test("clampWindow keeps the most recent part and reports it", () => {
  const w = resolveWindow({ since: "7d" }, NOW);
  const c = clampWindow(w, 24 * 3_600_000);
  assert.equal(c.clamped, true);
  assert.equal(iso(c.to), iso(w.to));
  assert.equal(iso(c.from), "2026-05-31T12:00:00.000Z");
  const same = clampWindow(w, 8 * 86_400_000);
  assert.equal(same.clamped, false);
  assert.equal(iso(same.from), iso(w.from));
});

// ---- servers ---------------------------------------------------------------

test("resolveServers returns all servers, one server, or lists the known slugs", () => {
  const reg = testRegistry();
  assert.deepEqual(resolveServers(reg).map((s) => s.slug), ["ovh-prod-1", "lab"]);
  assert.deepEqual(resolveServers(reg, "lab").map((s) => s.slug), ["lab"]);
  assert.throws(
    () => resolveServers(reg, "nope"),
    (err: unknown) => err instanceof ToolError && err.code === "unknown_server" && err.message.includes("ovh-prod-1, lab"),
  );
});

// ---- cursor ----------------------------------------------------------------

test("cursor round-trips and is opaque base64url", () => {
  const schema = z.object({ offset: z.number().int(), q: z.string() });
  const c = encodeCursor({ offset: 40, q: "é≠" });
  assert.match(c, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeCursor(c, schema), { offset: 40, q: "é≠" });
});

test("a tampered cursor gives a clean tool error", () => {
  const schema = z.object({ offset: z.number().int() });
  const code = (c: string): string | undefined => {
    try {
      decodeCursor(c, schema);
    } catch (err) {
      return err instanceof ToolError ? err.code : "other";
    }
  };
  assert.equal(code(encodeCursor({ offset: "x" })), "invalid_cursor");
  assert.equal(code(encodeCursor({ other: 1 })), "invalid_cursor");
  assert.equal(code(encodeCursor([1])), "invalid_cursor");
  assert.equal(code("!!!not base64!!!"), "invalid_cursor");
  assert.equal(code(Buffer.from("{not json").toString("base64url")), "invalid_cursor");
  assert.equal(code(""), "invalid_cursor");
  assert.equal(code("A".repeat(5000)), "invalid_cursor");
  assert.equal(code(encodeCursor({ offset: 1 }).slice(0, -3)), "invalid_cursor");
});

// ---- caps ------------------------------------------------------------------

const win = { from: new Date(NOW.getTime() - 3_600_000), to: NOW };
const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ i, line: `line-${i}-${"x".repeat(100)}` }));

test("resolveMaxBytes defaults to 16 KB and is bounded to 48 KB", () => {
  assert.equal(resolveMaxBytes(), DEFAULT_MAX_BYTES);
  assert.equal(DEFAULT_MAX_BYTES, 16 * 1024);
  assert.equal(resolveMaxBytes(1_000_000), MAX_MAX_BYTES);
  assert.equal(MAX_MAX_BYTES, 48 * 1024);
  assert.equal(resolveMaxBytes(10), 1024);
});

test("buildResult keeps everything that fits", () => {
  const b = buildResult({ summary: "3 lines", items: lines(3) }, win, {}, DEFAULT_MAX_BYTES);
  assert.equal(b.envelope.items.length, 3);
  assert.equal(b.envelope.truncated, false);
  assert.equal(b.envelope.next_cursor, undefined);
  assert.deepEqual(b.envelope.window, { from: iso(win.from), to: iso(win.to) });
});

test("buildResult drops items from the end until the result fits and flags truncation", () => {
  const items = lines(500);
  const b = buildResult({ summary: "500 lines", items }, win, { server: "s" }, 4096);
  assert.ok(b.envelope.items.length > 0 && b.envelope.items.length < 500);
  assert.deepEqual(b.envelope.items, items.slice(0, b.envelope.items.length));
  assert.equal(b.envelope.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(b.envelope)) <= 4096);
  assert.ok(Buffer.byteLength((b.result.content[0] as { text: string }).text) <= 4096);
  assert.equal(b.bytes, Buffer.byteLength(JSON.stringify(b.envelope)));
  assert.ok(b.bytes > 4096 / 2, "fills most of the budget");
  assert.match(b.envelope.summary, /capped at 4096 bytes/);
});

test("buildResult only offers the handler's cursor when no item was dropped, or computes it from the kept count", () => {
  const fits = buildResult({ summary: "s", items: lines(2), truncated: true, next_cursor: "page-2" }, win, {}, DEFAULT_MAX_BYTES);
  assert.equal(fits.envelope.next_cursor, "page-2");
  const cut = buildResult({ summary: "s", items: lines(500), truncated: true, next_cursor: "page-2" }, win, {}, 2048);
  assert.equal(cut.envelope.next_cursor, undefined);
  const computed = buildResult({ summary: "s", items: lines(500), truncated: true, next_cursor: (kept) => `after-${kept}` }, win, {}, 2048);
  assert.equal(computed.envelope.next_cursor, `after-${computed.envelope.items.length}`);
  const notTruncated = buildResult({ summary: "s", items: lines(1), next_cursor: (kept) => `after-${kept}` }, win, {}, 2048);
  assert.equal(notTruncated.envelope.next_cursor, undefined);
});

test("buildResult text block is the summary plus one compact line per item", () => {
  const b = buildResult({ summary: "2 things", items: [{ a: 1 }, { a: 2 }] }, win, {}, DEFAULT_MAX_BYTES);
  assert.equal((b.result.content[0] as { text: string }).text, '2 things\n{"a":1}\n{"a":2}');
  const f = buildResult({ summary: "2 things", items: [{ a: 1 }, { a: 2 }] }, win, {}, DEFAULT_MAX_BYTES, (i) => `a=${i.a}`);
  assert.equal((f.result.content[0] as { text: string }).text, "2 things\na=1\na=2");
  assert.deepEqual(f.result.structuredContent, f.envelope);
});

test("buildResult redacts secret-shaped strings in summary and items", () => {
  const gh = "ghp_" + "a".repeat(36);
  const b = buildResult({ summary: `found ${gh}`, items: [{ line: `token=${gh}`, nested: { v: [gh] } }] }, win, {}, DEFAULT_MAX_BYTES);
  const all = JSON.stringify(b.result);
  assert.ok(!all.includes(gh));
  assert.match(all, /REDACTED GitHub token/);
});

test("limitParam bounds and defaults", () => {
  const p = limitParam(50, 200);
  assert.equal(p.parse(undefined), 50);
  assert.equal(p.parse(200), 200);
  assert.ok(!p.safeParse(201).success);
  assert.ok(!p.safeParse(0).success);
  assert.ok(!p.safeParse(1.5).success);
});

// ---- defineTool end to end -------------------------------------------------

const Item = z.object({ n: z.number() });
const echo = defineTool({
  name: "test_echo",
  description: "Echo tool.",
  inputSchema: z.object({ ...scopeShape, limit: limitParam(3, 10), mode: z.enum(["ok", "tool-error", "crash", "big"]).default("ok") }),
  outputSchema: envelopeSchema(Item),
  formatItem: (i) => `n=${i.n}`,
  async handler(args, ctx) {
    if (args.mode === "tool-error") throw new ToolError("custom_code", "custom message");
    if (args.mode === "crash") throw new Error("boom with ghp_" + "a".repeat(36));
    const servers = resolveServers(ctx.registry, args.server);
    const window = resolveWindow(args, ctx.now());
    const count = args.mode === "big" ? 2000 : args.limit;
    return { summary: `${servers.length} server(s), ${count} items`, items: Array.from({ length: count }, (_, n) => ({ n })), window };
  },
});

test("defineTool appends the untrusted-data notice and read-only annotations", async () => {
  const { client } = await connect([echo]);
  const tool = (await client.listTools()).tools.find((t) => t.name === "test_echo")!;
  assert.ok(tool.description?.includes(UNTRUSTED_DATA_NOTICE));
  assert.equal(tool.annotations?.readOnlyHint, true);
  const props = Object.keys((tool.inputSchema as { properties: object }).properties);
  for (const p of ["server", "stack", "service", "since", "until", "limit", "max_bytes"]) assert.ok(props.includes(p), p);
  assert.ok(tool.outputSchema);
});

test("every registered tool carries the untrusted-data notice", async () => {
  const { client } = await connect(TOOLS);
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, TOOLS.length);
  for (const t of tools) assert.ok(t.description?.includes(UNTRUSTED_DATA_NOTICE), t.name);
});

test("a call returns structuredContent and a compact text block, and is audited without content", async () => {
  const { call, stores } = await connect([echo]);
  const r = await call("test_echo", { server: "lab", stack: "obs", service: "obs_loki", since: "30m", limit: 2 });
  assert.ok(!r.isError);
  const env = r.structuredContent as { items: unknown[]; scope: object; window: { from: string; to: string }; truncated: boolean };
  assert.equal(env.items.length, 2);
  assert.deepEqual(env.scope, { server: "lab", stack: "obs", service: "obs_loki" });
  assert.equal(env.window.to, "2026-06-01T12:00:00.000Z");
  assert.equal(env.window.from, "2026-06-01T11:30:00.000Z");
  assert.equal(textOf(r), "1 server(s), 2 items\nn=0\nn=1");

  const row = stores.db.prepare("SELECT * FROM audit_log").get() as Record<string, unknown>;
  assert.equal(row.tool, "test_echo");
  assert.equal(row.credential_id, "cred-1");
  assert.equal(row.credential_name, "test-client");
  assert.equal(row.server, "lab");
  assert.equal(row.stack, "obs");
  assert.equal(row.service, "obs_loki");
  assert.equal(row.window, "2026-06-01T11:30:00.000Z/2026-06-01T12:00:00.000Z");
  assert.equal(row.result, "ok");
  assert.equal(row.truncated, 0);
  assert.equal(row.result_bytes, Buffer.byteLength(JSON.stringify(r.structuredContent)));
  assert.equal(row.client_ip, "10.0.0.1");
  assert.match(String(row.query_hash), /^[0-9a-f]{16}$/);
  assert.match(String(row.query), /obs_loki/);
  assert.ok(!JSON.stringify(row).includes("n=1"), "result content is never audited");
});

test("the query hash does not depend on argument order and the query text is capped at 256 chars", async () => {
  const { call, stores } = await connect([echo]);
  await call("test_echo", { stack: "a", server: "lab" });
  await call("test_echo", { server: "lab", stack: "a" });
  const hashes = (stores.db.prepare("SELECT query_hash h FROM audit_log").all() as Array<{ h: string }>).map((r) => r.h);
  assert.equal(hashes[0], hashes[1]);
  const long = "s".repeat(128);
  await call("test_echo", { server: long, stack: long, service: long });
  const q = (stores.db.prepare("SELECT query FROM audit_log ORDER BY id DESC LIMIT 1").get() as { query: string }).query;
  assert.equal(q.length, 256);
});

test("max_bytes caps the result and the audit row records the truncation", async () => {
  const { call, stores } = await connect([echo]);
  const r = await call("test_echo", { mode: "big", limit: 1, max_bytes: 4096 });
  const env = r.structuredContent as { items: unknown[]; truncated: boolean };
  assert.equal(env.truncated, true);
  assert.ok(env.items.length > 0 && env.items.length < 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(env)) <= 4096);
  const row = stores.db.prepare("SELECT truncated, result_bytes FROM audit_log").get() as { truncated: number; result_bytes: number };
  assert.equal(row.truncated, 1);
  assert.ok(row.result_bytes <= 4096);
  const dflt = await call("test_echo", { mode: "big" });
  assert.ok(Buffer.byteLength(JSON.stringify(dflt.structuredContent)) <= DEFAULT_MAX_BYTES);
});

test("max_bytes above the ceiling is rejected by the schema", async () => {
  const { client } = await connect([echo]);
  const r = (await client.callTool({ name: "test_echo", arguments: { max_bytes: MAX_MAX_BYTES + 1 } })) as { isError?: boolean };
  assert.equal(r.isError, true);
});

test("a ToolError becomes an error result with its code, audited", async () => {
  const { call, stores } = await connect([echo]);
  const r = await call("test_echo", { mode: "tool-error" });
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "Error [custom_code]: custom message");
  const row = stores.db.prepare("SELECT result, detail FROM audit_log").get() as { result: string; detail: string };
  assert.equal(row.result, "custom_code");
  assert.equal(row.detail, "custom message");
});

test("an unknown server lists the known slugs", async () => {
  const { call, stores } = await connect([echo]);
  const r = await call("test_echo", { server: "nope" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Error \[unknown_server\].*ovh-prod-1, lab/);
  assert.equal((stores.db.prepare("SELECT result FROM audit_log").get() as { result: string }).result, "unknown_server");
});

test("an invalid window is a tool error", async () => {
  const { call } = await connect([echo]);
  const r = await call("test_echo", { since: "2026-06-01T13:00:00Z" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Error \[invalid_window\]/);
});

test("unexpected errors are masked and never leak their message", async () => {
  const { call, stores } = await connect([echo]);
  const prev = console.error;
  console.error = () => {};
  try {
    const r = await call("test_echo", { mode: "crash" });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), "Error [internal]: Internal error.");
  } finally {
    console.error = prev;
  }
  assert.equal((stores.db.prepare("SELECT result FROM audit_log").get() as { result: string }).result, "internal");
});

test("an audit failure never fails the call", async () => {
  const { call, stores } = await connect([echo]);
  stores.db.exec("DROP TABLE audit_log");
  const prev = console.error;
  console.error = () => {};
  try {
    const r = await call("test_echo", { limit: 1 });
    assert.ok(!r.isError);
  } finally {
    console.error = prev;
  }
});

// ---- guard, redaction, signal ----------------------------------------------

const gate = defineTool({
  name: "test_gate",
  description: "Blocks until released.",
  inputSchema: z.object({ mode: z.enum(["wait", "leak-error", "leak-tool-error", "signal"]).default("wait") }),
  outputSchema: envelopeSchema(Item),
  async handler(args, ctx) {
    const token = "ghp_" + "b".repeat(36);
    if (args.mode === "leak-error") throw new Error(`failed with https://user:pw@host/x and ${token}`);
    if (args.mode === "leak-tool-error") throw new ToolError("upstream", `bad ${token} at https://u:p@h/`);
    if (args.mode === "signal") return { summary: ctx.signal instanceof AbortSignal ? "signal ok" : "no signal", items: [] };
    await new Promise((r) => setTimeout(r, 80));
    return { summary: "done", items: [] };
  },
});

function guard(over: Partial<ToolGuard> = {}): ToolGuard {
  return { calls: new RateLimiter(100, 60_000), slots: new SlotLimiter(10), maxPerCredential: 1, track: () => () => {}, ...over };
}

test("concurrency is limited per credential per tool call, refusals are audited as busy", async () => {
  const { call, stores } = await connect([gate], { guard: guard() });
  const [a, b] = await Promise.all([call("test_gate"), call("test_gate")]);
  const results = [a, b];
  assert.equal(results.filter((r) => r.isError).length, 1);
  assert.match(textOf(results.find((r) => r.isError)!), /Error \[busy\]/);
  const audited = (stores.db.prepare("SELECT result FROM audit_log ORDER BY id").all() as Array<{ result: string }>).map((r) => r.result).sort();
  assert.deepEqual(audited, ["busy", "ok"]);
  assert.ok(!(await call("test_gate")).isError, "slot released after the handler settled");
});

test("the global slot cap applies across credentials", async () => {
  const slots = new SlotLimiter(1);
  const { call } = await connect([gate], { guard: guard({ slots, maxPerCredential: 5 }) });
  const [a, b] = await Promise.all([call("test_gate"), call("test_gate")]);
  assert.equal([a, b].filter((r) => r.isError).length, 1);
});

test("the call rate limit answers rate_limited and is audited", async () => {
  const { call, stores } = await connect([gate], { guard: guard({ calls: new RateLimiter(1, 60_000), maxPerCredential: 5 }) });
  assert.ok(!(await call("test_gate", { mode: "signal" })).isError);
  const r = await call("test_gate", { mode: "signal" });
  assert.match(textOf(r), /Error \[rate_limited\]/);
  assert.equal((stores.db.prepare("SELECT result FROM audit_log ORDER BY id DESC LIMIT 1").get() as { result: string }).result, "rate_limited");
});

test("handlers are tracked as in flight until they settle", async () => {
  let inflight = 0;
  let peak = 0;
  const { call } = await connect([gate], { guard: guard({ track: () => { peak = Math.max(peak, ++inflight); return () => void inflight--; } }) });
  await call("test_gate");
  assert.equal(peak, 1);
  assert.equal(inflight, 0);
});

test("the handler gets an abort signal", async () => {
  const { call } = await connect([gate]);
  assert.equal((await call("test_gate", { mode: "signal" })).structuredContent?.summary, "signal ok");
});

test("secrets and URL credentials never reach the client, the audit row or the log", async () => {
  const { call, stores } = await connect([gate]);
  const logged: string[] = [];
  const prev = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const internal = await call("test_gate", { mode: "leak-error" });
    assert.equal(textOf(internal), "Error [internal]: Internal error.");
    const tool = await call("test_gate", { mode: "leak-tool-error" });
    assert.ok(!/ghp_b|u:p@/.test(textOf(tool)));
    assert.match(textOf(tool), /REDACTED GitHub token/);
  } finally {
    console.error = prev;
  }
  const rows = JSON.stringify(stores.db.prepare("SELECT detail FROM audit_log").all());
  assert.ok(!/ghp_b|user:pw|u:p@/.test(rows), rows);
  assert.match(rows, /REDACTED GitHub token/);
  assert.match(rows, /\*\*\*@/);
  assert.ok(!/ghp_b|user:pw/.test(logged.join("\n")));
});

test("a 0-item envelope always fits the smallest cap, whatever the summary and scope", () => {
  const name = "n".repeat(128);
  const b = buildResult({ summary: "é".repeat(5000), items: [{ line: "x".repeat(2000) }] }, win, { server: name, stack: name, service: name }, 1024);
  assert.equal(b.envelope.items.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(b.envelope)) <= 1024);
  assert.ok(Buffer.byteLength((b.result.content[0] as { text: string }).text) <= 1024);
});

test("scope names are bounded and plain", () => {
  const s = z.object(scopeShape);
  assert.ok(s.safeParse({ server: "ovh-prod-1", stack: "obs", service: "carapp_php" }).success);
  for (const bad of ["", "a".repeat(129), 'x"}|{', "a b", "-lead", "a/b"]) assert.ok(!s.safeParse({ service: bad }).success, bad);
});

test("the audit query hash ignores key order at every depth", async () => {
  const nested = defineTool({ name: "test_nested", description: "d", inputSchema: z.object({ a: z.object({ x: z.number(), y: z.number() }).optional() }), outputSchema: envelopeSchema(Item), handler: async () => ({ summary: "s", items: [] }) });
  const { call, stores } = await connect([nested]);
  await call("test_nested", { a: { x: 1, y: 2 } });
  await call("test_nested", { a: { y: 2, x: 1 } });
  const h = (stores.db.prepare("SELECT query_hash h FROM audit_log").all() as Array<{ h: string }>).map((r) => r.h);
  assert.equal(h[0], h[1]);
});
