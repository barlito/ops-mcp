import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ToolError } from "../tools/contract";
import { PromClient } from "./PromClient";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())))));
});

async function stub(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<string> {
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const rejectsWith = (p: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(p, (e) => e instanceof ToolError && e.code === code && (!message || message.test(e.message)));

const win = { from: new Date(1000_000), to: new Date(1003_600_000) };

test("query posts a form and parses instant samples, dropping NaN and Inf", async () => {
  let seen = { path: "", body: "" };
  const url = await stub((req, res, body) => {
    seen = { path: req.url ?? "", body };
    json(res, 200, { status: "success", data: { resultType: "vector", result: [{ metric: { server: "a" }, value: [1, "2.5"] }, { metric: {}, value: [1, "NaN"] }, { metric: {}, value: [1, "+Inf"] }] } });
  });
  const out = await new PromClient(url).query('up{a="b"}', new Date(5000));
  assert.deepEqual(out, [{ labels: { server: "a" }, value: 2.5 }]);
  assert.equal(seen.path, "/api/v1/query");
  const form = new URLSearchParams(seen.body);
  assert.equal(form.get("query"), 'up{a="b"}');
  assert.equal(form.get("time"), "5");
  assert.match(form.get("timeout") ?? "", /^\d+s$/);
});

test("queryRange sends start, end and step and parses points", async () => {
  let form = new URLSearchParams();
  const url = await stub((_req, res, body) => {
    form = new URLSearchParams(body);
    json(res, 200, { status: "success", data: { resultType: "matrix", result: [{ metric: { a: "1" }, values: [[1000, "1"], [1075, "NaN"], [1150, "3"]] }] } });
  });
  const out = await new PromClient(`${url}/`).queryRange("up", win, 75);
  assert.deepEqual(out, [{ labels: { a: "1" }, points: [[1000, 1], [1150, 3]] }]);
  assert.deepEqual([form.get("start"), form.get("end"), form.get("step")], ["1000", "1003600", "75"]);
});

test("alerts reads /api/v1/alerts with GET", async () => {
  const url = await stub((req, res) => {
    assert.equal(req.method, "GET");
    json(res, 200, { status: "success", data: { alerts: [{ labels: { alertname: "X" }, annotations: {}, state: "firing" }] } });
  });
  assert.equal((await new PromClient(url).alerts())[0]?.labels.alertname, "X");
});

test("a rejected query becomes query_rejected with secrets redacted", async () => {
  const url = await stub((_req, res) => json(res, 400, { status: "error", errorType: "bad_data", error: "parse error: bad token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }));
  await assert.rejects(new PromClient(url).query("x(", new Date()), (e) => {
    assert.ok(e instanceof ToolError && e.code === "query_rejected");
    assert.match(e.message, /parse error/);
    assert.doesNotMatch(e.message, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
    return true;
  });
});

test("Prometheus-side timeout and a silent server are backend_timeout", async () => {
  const slow = await stub((_req, res) => json(res, 503, { status: "error", errorType: "timeout", error: "query timed out" }));
  await rejectsWith(new PromClient(slow).query("up", new Date()), "backend_timeout");
  const hung = await stub(() => {});
  await rejectsWith(new PromClient(hung, { timeoutMs: 100 }).query("up", new Date()), "backend_timeout", /100 ms/);
});

test("unreachable backend and unexpected answers are backend_unavailable", async () => {
  await rejectsWith(new PromClient("http://127.0.0.1:1").query("up", new Date()), "backend_unavailable", /unreachable/);
  const down = await stub((_req, res) => json(res, 502, {}));
  await rejectsWith(new PromClient(down).query("up", new Date()), "backend_unavailable", /HTTP 502/);
  const html = await stub((_req, res) => res.end("<html>"));
  await rejectsWith(new PromClient(html).query("up", new Date()), "backend_unavailable", /HTTP 200/);
});

test("at most `slots` requests are in flight, the others wait", async () => {
  let inFlight = 0;
  let peak = 0;
  const url = await stub((_req, res) => {
    peak = Math.max(peak, ++inFlight);
    setTimeout(() => {
      inFlight--;
      json(res, 200, { status: "success", data: { result: [] } });
    }, 30);
  });
  const client = new PromClient(url, { slots: 2 });
  await Promise.all(Array.from({ length: 6 }, () => client.query("up", new Date())));
  assert.equal(peak, 2);
});

test("a response beyond the byte cap is refused", async () => {
  const big = await stub((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "success", data: { result: [{ metric: { pad: "x".repeat(5 * 1024 * 1024) }, value: [1, "1"] }] } }));
  });
  await rejectsWith(new PromClient(big).query("up", new Date()), "query_rejected", /result too large/);
});

test("an aborted caller gets `cancelled`, also while waiting for a slot", async () => {
  const url = await stub(() => {});
  const client = new PromClient(url, { slots: 1, timeoutMs: 5000 });
  const first = new AbortController();
  const second = new AbortController();
  const running = client.query("up", new Date(), { signal: first.signal });
  const queued = client.query("up", new Date(), { signal: second.signal });
  setTimeout(() => (second.abort(), first.abort()), 30);
  await rejectsWith(queued, "cancelled");
  await rejectsWith(running, "cancelled");
});

test("waiting for a slot is bounded by the timeout", async () => {
  const url = await stub(() => {});
  const client = new PromClient(url, { slots: 1, timeoutMs: 150 });
  const running = client.query("up", new Date());
  await rejectsWith(client.query("up", new Date()), "backend_timeout", /no free query slot/);
  await rejectsWith(running, "backend_timeout");
});

test("the series limit is sent when asked", async () => {
  let form = new URLSearchParams();
  const url = await stub((_req, res, body) => {
    form = new URLSearchParams(body);
    json(res, 200, { status: "success", data: { result: [] } });
  });
  await new PromClient(url).queryRange("up", win, 75, { limit: 21 });
  assert.equal(form.get("limit"), "21");
});
