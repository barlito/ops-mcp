import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cachedClusterSources, createClusterSource, UnsupportedSourceError } from "./ClusterSource";
import { LocalDockerSource } from "./LocalDockerSource";
import { testRegistry } from "../test-support/fixtures";

let server: Server;
let url: string;
let swarmState = "active";

before(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/version") res.end(JSON.stringify({ Version: "29.9.2" }));
    else if (req.url === "/info") res.end(JSON.stringify({ Swarm: { LocalNodeState: swarmState } }));
    else if (req.url?.startsWith("/slow")) setTimeout(() => res.end("{}"), 500);
    else res.writeHead(403).end(JSON.stringify({ message: "forbidden" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `tcp://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

test("info reads /version and /info through a tcp:// url", async () => {
  assert.deepEqual(await new LocalDockerSource(url).info(), { reachable: true, dockerVersion: "29.9.2", swarm: true });
  swarmState = "inactive";
  assert.equal((await new LocalDockerSource(url).info()).swarm, false);
  swarmState = "active";
});

test("an unreachable proxy is reported, not thrown", async () => {
  const r = await new LocalDockerSource("tcp://127.0.0.1:1").info();
  assert.equal(r.reachable, false);
  assert.ok(r.error);
});

test("a forbidden endpoint is reported as an error", async () => {
  const s = new LocalDockerSource(url.replace("tcp://", "http://") + "/nope-prefix");
  const r = await s.info();
  assert.equal(r.reachable, false);
  assert.match(r.error ?? "", /HTTP 403/);
});

test("a slow proxy times out", async () => {
  const r = await new LocalDockerSource(url + "/slow-prefix", 50).info();
  assert.equal(r.reachable, false);
  assert.equal(r.error, "timeout after 50 ms");
});

test("the factory builds local sources and refuses agent sources", () => {
  const [local, agent] = testRegistry().servers;
  assert.ok(createClusterSource(local!) instanceof LocalDockerSource);
  assert.throws(() => createClusterSource(agent!), UnsupportedSourceError);
});

test("cachedClusterSources builds one source per server", () => {
  let built = 0;
  const get = cachedClusterSources((s) => {
    built++;
    return { info: async () => ({ reachable: true, swarm: true, error: s.slug }) };
  });
  const [a, b] = testRegistry().servers;
  assert.equal(get(a!), get(a!));
  assert.notEqual(get(a!), get(b!));
  assert.equal(built, 2);
});
