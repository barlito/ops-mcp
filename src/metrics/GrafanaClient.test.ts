import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ToolError } from "../tools/contract";
import { writeTemp } from "../test-support/fixtures";
import { GrafanaClient, grafanaFromEnv } from "./GrafanaClient";

async function withStub(status: number, body: unknown, run: (url: string, seen: { path?: string; auth?: string }) => Promise<void>) {
  const seen: { path?: string; auth?: string } = {};
  const s = createServer((req, res) => {
    seen.path = req.url;
    seen.auth = req.headers.authorization;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen);
  } finally {
    await new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())));
  }
}

test("reads the Prometheus-compatible alerts endpoint with the bearer token", async () => {
  await withStub(200, { status: "success", data: { alerts: [{ labels: { alertname: "G" }, annotations: {}, state: "Alerting" }] } }, async (url, seen) => {
    const alerts = await new GrafanaClient(url, "glsa_x").alerts();
    assert.equal(alerts[0]?.labels.alertname, "G");
    assert.equal(seen.path, "/api/prometheus/grafana/api/v1/alerts");
    assert.equal(seen.auth, "Bearer glsa_x");
  });
});

test("a refused token is backend_unavailable", async () => {
  await withStub(401, { message: "invalid API key" }, async (url) => {
    await assert.rejects(new GrafanaClient(url, "bad").alerts(), (e) => e instanceof ToolError && e.code === "backend_unavailable" && /HTTP 401: invalid API key/.test(e.message));
  });
});

test("grafanaFromEnv: off without a URL, a client with a token file, a failing source when the token is unreadable", async () => {
  const file = writeTemp("grafana-token", "glsa_secret\n");
  assert.equal(grafanaFromEnv({}), undefined);
  assert.equal(grafanaFromEnv({ GRAFANA_TOKEN_FILE: file }), undefined);
  assert.ok(grafanaFromEnv({ GRAFANA_URL: "http://g", GRAFANA_TOKEN_FILE: file }) instanceof GrafanaClient);
  const warn = mock.method(console, "warn", () => {});
  try {
    for (const env of [{ GRAFANA_URL: "http://g" }, { GRAFANA_URL: "http://g", GRAFANA_TOKEN_FILE: "/nonexistent/token" }, { GRAFANA_URL: "http://g", GRAFANA_TOKEN: "plain" }]) {
      const source = grafanaFromEnv(env);
      assert.ok(source && !(source instanceof GrafanaClient));
      await assert.rejects(source.alerts(), (e) => e instanceof ToolError && /token file is missing or unreadable/.test(e.message));
    }
    assert.equal(warn.mock.callCount(), 3);
  } finally {
    warn.mock.restore();
  }
});

test("a caller signal aborts the request", async () => {
  const s = createServer(() => {});
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  try {
    const ac = new AbortController();
    const p = new GrafanaClient(`http://127.0.0.1:${(s.address() as AddressInfo).port}`, "t", 5000).alerts({ signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, (e) => e instanceof ToolError && e.code === "cancelled");
  } finally {
    await new Promise<void>((r) => (s.closeAllConnections(), s.close(() => r())));
  }
});
