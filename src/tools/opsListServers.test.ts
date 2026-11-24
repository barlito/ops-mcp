import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createClusterSource } from "../cluster/ClusterSource";
import { parseRegistry } from "../registry";
import { connect, fakeCluster, textOf } from "../test-support/mcp";
import { opsListServers } from "./opsListServers";

test("lists every registry server with its reachability", async () => {
  const { call } = await connect([opsListServers], {
    cluster: fakeCluster((slug) => ({ info: async () => (slug === "ovh-prod-1" ? { reachable: true, swarm: true, dockerVersion: "29.9.2" } : { reachable: false, swarm: false, error: "ECONNREFUSED" }) })),
  });
  const r = await call("ops_list_servers");
  assert.ok(!r.isError);
  assert.deepEqual(r.structuredContent, {
    summary: "2 servers, 1 reachable",
    items: [
      { server: "ovh-prod-1", env: "production", kind: "swarm", tenant: "barlito", reachable: true, docker_version: "29.9.2" },
      { server: "lab", env: "development", kind: "compose", tenant: "barlito", reachable: false, error: "ECONNREFUSED" },
    ],
    truncated: false,
    window: { from: "2026-06-01T12:00:00.000Z", to: "2026-06-01T12:00:00.000Z" },
    scope: {},
  });
  assert.equal(textOf(r), "2 servers, 1 reachable\novh-prod-1 env=production kind=swarm tenant=barlito up docker=29.9.2\nlab env=development kind=compose tenant=barlito DOWN ECONNREFUSED");
});

test("a source that throws makes its server unreachable instead of failing the call", async () => {
  const { call } = await connect([opsListServers], {
    cluster: () => {
      throw new Error("boom");
    },
  });
  const r = await call("ops_list_servers");
  assert.ok(!r.isError);
  assert.match(r.structuredContent?.summary as string, /2 servers, 0 reachable/);
});

test("end to end against a local docker-socket-proxy stub, agent servers reported unreachable", async () => {
  const stub = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/version" ? { Version: "28.1.1" } : { Swarm: { LocalNodeState: "active" } }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  try {
    const port = (stub.address() as AddressInfo).port;
    const registry = parseRegistry(`
tenants: [{slug: t}]
servers:
  - { slug: up, env: production, kind: swarm, tenant: t, source: { type: local, url: "tcp://127.0.0.1:${port}" } }
  - { slug: down, env: production, kind: swarm, tenant: t, source: { type: local, url: "tcp://127.0.0.1:1" } }
  - { slug: remote, env: production, kind: compose, tenant: t, source: { type: agent } }
`);
    const { call } = await connect([opsListServers], { registry, cluster: createClusterSource });
    const items = (await call("ops_list_servers")).structuredContent?.items as Array<{ server: string; reachable: boolean; docker_version?: string; error?: string }>;
    assert.deepEqual(items.map((i) => [i.server, i.reachable]), [["up", true], ["down", false], ["remote", false]]);
    assert.equal(items[0]?.docker_version, "28.1.1");
    assert.ok(items[1]?.error);
    assert.match(items[2]?.error ?? "", /not implemented/);
  } finally {
    await new Promise<void>((r) => stub.close(() => r()));
  }
});

test("max_bytes is the only parameter", async () => {
  const { client } = await connect([opsListServers]);
  const tool = (await client.listTools()).tools[0]!;
  assert.deepEqual(Object.keys((tool.inputSchema as { properties: object }).properties), ["max_bytes"]);
});
