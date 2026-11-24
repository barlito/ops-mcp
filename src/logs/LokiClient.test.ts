import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ToolError } from "../tools/contract";
import { type LokiApi, LokiClient, withConcurrency } from "./LokiClient";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

async function withLoki<T>(handler: Handler, fn: (url: string) => Promise<T>): Promise<T> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const json = (res: ServerResponse, body: unknown, status = 200): void => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

const range = { query: '{server="a"}', start: 1n, end: 2n };

const code = (c: string) => (e: unknown) => e instanceof ToolError && e.code === c;

test("queryRange sends ns timestamps and parses streams", async () => {
  let seen = "";
  await withLoki(
    (req, res) => {
      seen = req.url ?? "";
      json(res, { status: "success", data: { resultType: "streams", result: [{ stream: { server: "a" }, values: [["1780315200123456789", "hello"]] }] } });
    },
    async (url) => {
      const data = await new LokiClient({ url }).queryRange({ ...range, limit: 7, direction: "forward" });
      assert.deepEqual(data, { type: "streams", streams: [{ labels: { server: "a" }, values: [[1780315200123456789n, "hello"]] }] });
      const q = new URL(seen, "http://x").searchParams;
      assert.deepEqual([q.get("query"), q.get("start"), q.get("end"), q.get("limit"), q.get("direction")], ['{server="a"}', "1", "2", "7", "forward"]);
    },
  );
});

test("matrix and vector results both become series", async () => {
  const bodies = [
    { resultType: "matrix", result: [{ metric: { a: "b" }, values: [[1, "2"], [3, "4"]] }] },
    { resultType: "vector", result: [{ metric: { a: "b" }, value: [1, "2"] }] },
  ];
  let i = 0;
  await withLoki((_req, res) => json(res, { status: "success", data: bodies[i++] }), async (url) => {
    const c = new LokiClient({ url });
    assert.deepEqual(await c.queryRange({ ...range, step: 60 }), { type: "series", series: [{ labels: { a: "b" }, points: [[1, "2"], [3, "4"]] }] });
    assert.deepEqual(await c.query({ query: "x", time: 5n }), { type: "series", series: [{ labels: { a: "b" }, points: [[1, "2"]] }] });
  });
});

test("HTTP 400 is query_rejected with Loki's message redacted", async () => {
  await withLoki(
    (_req, res) => {
      res.statusCode = 400;
      res.end("parse error: bad token=hunter2 at postgres://u:pw@h/db");
    },
    async (url) => {
      await assert.rejects(new LokiClient({ url }).queryRange(range), (e) => {
        assert.ok(e instanceof ToolError && e.code === "query_rejected");
        assert.ok(!/hunter2|:pw@/.test(e.message), e.message);
        assert.match(e.message, /parse error/);
        return true;
      });
    },
  );
});

test("server errors map to backend_unavailable, 504 to backend_timeout", async () => {
  for (const [status, expected] of [[500, "backend_unavailable"], [503, "backend_unavailable"], [429, "backend_unavailable"], [504, "backend_timeout"]] as const) {
    await withLoki((_req, res) => { res.statusCode = status; res.end("boom"); }, async (url) => {
      await assert.rejects(new LokiClient({ url }).queryRange(range), code(expected), String(status));
    });
  }
  await withLoki((_req, res) => res.end("not json"), async (url) => {
    await assert.rejects(new LokiClient({ url }).queryRange(range), code("backend_unavailable"));
  });
  await withLoki((_req, res) => json(res, { status: "success", data: { resultType: "scalar", result: [] } }), async (url) => {
    await assert.rejects(new LokiClient({ url }).queryRange(range), code("backend_unavailable"));
  });
});

test("an unreachable Loki is backend_unavailable, a slow one backend_timeout", async () => {
  await assert.rejects(new LokiClient({ url: "http://127.0.0.1:1" }).queryRange(range), code("backend_unavailable"));
  await withLoki(() => undefined, async (url) => {
    await assert.rejects(new LokiClient({ url, timeoutMs: 100 }).queryRange(range), code("backend_timeout"));
  });
});

test("concurrency is bounded: with no queue wait the extra query fails and the slot is released afterwards", async () => {
  const held: ServerResponse[] = [];
  await withLoki((_req, res) => { held.push(res); }, async (url) => {
    const c = new LokiClient({ url, concurrency: 1, timeoutMs: 5000, queueWaitMs: 0 });
    const first = c.queryRange(range);
    first.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(c.queryRange(range), code("backend_busy"));
    json(held[0]!, { status: "success", data: { resultType: "streams", result: [] } });
    await first;
    const second = c.queryRange(range);
    await new Promise((r) => setTimeout(r, 50));
    json(held[1]!, { status: "success", data: { resultType: "streams", result: [] } });
    await second;
  });
});

test("an aborted caller stops the request with a cancelled error", async () => {
  await withLoki(() => undefined, async (url) => {
    const ctl = new AbortController();
    const p = new LokiClient({ url, timeoutMs: 5000 }).queryRange(range, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(p, code("cancelled"));
  });
});

test("a query waits for a free slot, gives up after the queue wait, and the wait is abortable", async () => {
  const held: ServerResponse[] = [];
  await withLoki((_req, res) => { held.push(res); }, async (url) => {
    const c = new LokiClient({ url, concurrency: 1, timeoutMs: 5000, queueWaitMs: 400 });
    const first = c.queryRange(range);
    await new Promise((r) => setTimeout(r, 50));
    const waiting = c.queryRange(range);
    setTimeout(() => json(held[0]!, { status: "success", data: { resultType: "streams", result: [] } }), 100);
    await first;
    await new Promise((r) => setTimeout(r, 30));
    json(held[1]!, { status: "success", data: { resultType: "streams", result: [] } });
    await waiting;

    const blocker = c.queryRange(range);
    blocker.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(c.queryRange(range), code("backend_busy"));
    const ctl = new AbortController();
    const aborted = c.queryRange(range, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(aborted, code("cancelled"));
    json(held[2]!, { status: "success", data: { resultType: "streams", result: [] } });
    await blocker;
  });
});

test("a body that never finishes is a backend_timeout", async () => {
  await withLoki((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write("{"); }, async (url) => {
    await assert.rejects(new LokiClient({ url, timeoutMs: 150 }).queryRange(range), code("backend_timeout"));
  });
});

test("withConcurrency never runs more than the allowed requests at once and finishes them all", async () => {
  let active = 0;
  let peak = 0;
  const slow: LokiApi = {
    query: async () => (peak = Math.max(peak, ++active), await new Promise((r) => setTimeout(r, 10)), active--, { type: "series", series: [] }),
    queryRange: async () => (peak = Math.max(peak, ++active), await new Promise((r) => setTimeout(r, 10)), active--, { type: "streams", streams: [] }),
  };
  const limited = withConcurrency(slow, 2);
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => (i % 2 ? limited.query({ query: "x", time: 0n }) : limited.queryRange({ query: "x", start: 0n, end: 1n }))));
  assert.equal(results.length, 9);
  assert.equal(peak, 2);
});

test("a result larger than the body cap is query_rejected", async () => {
  await withLoki((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ status: "success", data: { resultType: "streams", result: [], pad: "x".repeat(5000) } })); }, async (url) => {
    await assert.rejects(new LokiClient({ url, maxBodyBytes: 1000 }).queryRange(range), (e) => e instanceof ToolError && e.code === "query_rejected" && /too large/.test(e.message));
  });
});
