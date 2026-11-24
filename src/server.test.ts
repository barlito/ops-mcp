import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LokiClient } from "./logs/LokiClient";
import { createApp } from "./server";
import { AuthFailureLimiter } from "./platform/http";
import { RateLimiter } from "./platform/rateLimit";
import { fakeCluster } from "./test-support/mcp";
import { testRegistry, testStores, type TestStores } from "./test-support/fixtures";
import { createServer } from "node:http";

let stores: TestStores;
let server: Server;
let base: string;
let bearer: string;
let key: string;

before(async () => {
  stores = testStores();
  bearer = stores.tokens.create("script").token;
  key = stores.connectorKeys.create("claude-ai").key;
  const app = createApp({
    ...stores,
    tools: { registry: testRegistry(), audit: stores.audit, loki: new LokiClient({ url: "http://127.0.0.1:1" }), cluster: fakeCluster((slug) => ({ info: async () => ({ reachable: slug === "ovh-prod-1", swarm: true, dockerVersion: "29.0.0", error: slug === "ovh-prod-1" ? undefined : "down" }) })) },
    authLimiter: new AuthFailureLimiter(1000),
    callLimiter: new RateLimiter(1000, 60_000),
  });
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (method: string, params: unknown = {}, id: number | undefined = 1) => ({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) });
const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/mcp`, { method: "POST", headers: { ...HEADERS, ...headers }, body: JSON.stringify(body) });
const toolsOf = (s: TestStores) => ({ registry: testRegistry(), audit: s.audit, loki: new LokiClient({ url: "http://127.0.0.1:1" }), cluster: fakeCluster(() => ({ info: async () => ({ reachable: true, swarm: true }) })) });

async function withApp(opts: Parameters<typeof createApp>[0], fn: (mcpUrl: string) => Promise<void>): Promise<void> {
  const srv = createServer(createApp(opts));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

const callListServers = (headers: Record<string, string>) => post(rpc("tools/call", { name: "ops_list_servers", arguments: {} }), headers);

test("/health is public", async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: "ok" });
});

test("401 without credentials, with a bad Bearer token and with a bad connector key", async () => {
  const cases: Array<Record<string, string>> = [{}, { authorization: "Bearer ops_nope" }, { authorization: "Basic abc" }, { "x-api-key": "opsk_nope-nope" }, { "x-api-key": "" }];
  for (const headers of cases) {
    const r = await callListServers(headers);
    assert.equal(r.status, 401, JSON.stringify(headers));
    assert.ok((await r.json() as { error: string }).error);
  }
});

test("a bad Authorization header is not rescued by a valid connector key", async () => {
  assert.equal((await callListServers({ authorization: "Bearer ops_nope", "x-api-key": key })).status, 401);
});

test("Bearer token is accepted and ops_list_servers answers", async () => {
  const r = await callListServers({ authorization: `Bearer ${bearer}` });
  assert.equal(r.status, 200);
  const res = ((await r.json()) as { result: { isError?: boolean; structuredContent: { summary: string; items: Array<{ server: string; reachable: boolean }> } } }).result;
  assert.ok(!res.isError);
  assert.equal(res.structuredContent.summary, "2 servers, 1 reachable");
  assert.deepEqual(res.structuredContent.items.map((i) => [i.server, i.reachable]), [["ovh-prod-1", true], ["lab", false]]);
});

test("x-api-key connector key is accepted", async () => {
  const r = await callListServers({ "x-api-key": key });
  assert.equal(r.status, 200);
  assert.ok(!((await r.json()) as { result: { isError?: boolean } }).result.isError);
});

test("initialize and tools/list work and the server carries instructions", async () => {
  const headers = { authorization: `Bearer ${bearer}` };
  const init = (await (await post(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }), headers)).json()) as { result: { instructions: string; serverInfo: { name: string } } };
  assert.equal(init.result.serverInfo.name, "ops-mcp");
  assert.match(init.result.instructions, /read-only/);
  const list = (await (await post(rpc("tools/list"), headers)).json()) as { result: { tools: Array<{ name: string }> } };
  assert.ok(list.result.tools.map((t) => t.name).includes("ops_list_servers"));
});

test("revoked and expired credentials get 401", async () => {
  const t = stores.tokens.create("temp");
  stores.tokens.revoke(t.id);
  assert.equal((await callListServers({ authorization: `Bearer ${t.token}` })).status, 401);
  const e = stores.tokens.create("old");
  stores.db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), e.id);
  const r = await callListServers({ authorization: `Bearer ${e.token}` });
  assert.equal(r.status, 401);
  assert.equal(((await r.json()) as { error: string }).error, "token expired");
  const k = stores.connectorKeys.create("gone");
  stores.connectorKeys.revoke(k.id);
  assert.equal((await callListServers({ "x-api-key": k.key })).status, 401);
});

test("tool calls are audited with the calling credential, auth failures without one", async () => {
  const s = testStores();
  const t = s.tokens.create("script");
  await withApp({ ...s, tools: toolsOf(s) }, async (url) => {
    const go = (authorization: string) => fetch(url, { method: "POST", headers: { ...HEADERS, authorization }, body: JSON.stringify(rpc("tools/call", { name: "ops_list_servers", arguments: {} })) });
    await go("Bearer ops_wrong");
    await go(`Bearer ${t.token}`);
  });
  const rows = s.db.prepare("SELECT * FROM audit_log ORDER BY id").all() as Array<Record<string, unknown>>;
  const fail = rows.find((r) => r.tool === "auth")!;
  assert.equal(fail.credential_id, null);
  assert.equal(fail.result, "denied");
  const call = rows.find((r) => r.tool === "ops_list_servers")!;
  assert.equal(call.credential_name, "script");
  assert.equal(call.result, "ok");
});

test("GET and DELETE on /mcp are refused (stateless)", async () => {
  const headers = { authorization: `Bearer ${bearer}` };
  assert.equal((await fetch(`${base}/mcp`, { headers })).status, 405);
  assert.equal((await fetch(`${base}/mcp`, { method: "DELETE", headers })).status, 405);
});

test("JSON-RPC batches and invalid JSON are refused", async () => {
  const headers = { authorization: `Bearer ${bearer}` };
  for (const batch of [[rpc("tools/list")], [rpc("tools/list", {}, 1), rpc("tools/list", {}, 2)], []]) {
    const r = await post(batch, headers);
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: { message: string } }).error.message, /batches are not supported/);
  }
  const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { ...HEADERS, ...headers }, body: "{nope" });
  assert.equal(bad.status, 400);
});

test("repeated failures from one client end in 429, but valid credentials still pass", async () => {
  const s = testStores();
  const t = s.tokens.create("ok");
  await withApp({ ...s, tools: toolsOf(s), authLimiter: new AuthFailureLimiter(3) }, async (url) => {
    const go = (authorization: string) => fetch(url, { method: "POST", headers: { ...HEADERS, authorization }, body: JSON.stringify(rpc("tools/list")) }).then((r) => r.status);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push(await go("Bearer ops_wrong"));
    assert.deepEqual(statuses, [401, 401, 401, 429, 429, 429]);
    assert.equal(await go(`Bearer ${t.token}`), 200);
  });
});

test("per-credential call rate limit is enforced per tool call and audited", async () => {
  const s = testStores();
  const t = s.tokens.create("limited");
  await withApp({ ...s, tools: toolsOf(s), callLimiter: new RateLimiter(2, 60_000) }, async (url) => {
    const go = async () => ((await (await fetch(url, { method: "POST", headers: { ...HEADERS, authorization: `Bearer ${t.token}` }, body: JSON.stringify(rpc("tools/call", { name: "ops_list_servers", arguments: {} })) })).json()) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
    assert.ok(!(await go()).isError);
    assert.ok(!(await go()).isError);
    const third = await go();
    assert.equal(third.isError, true);
    assert.match(third.content[0]!.text, /rate_limited/);
    assert.equal((s.db.prepare("SELECT result FROM audit_log ORDER BY id DESC LIMIT 1").get() as { result: string }).result, "rate_limited");
  });
});
