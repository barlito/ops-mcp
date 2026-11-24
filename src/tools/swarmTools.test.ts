import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createClusterSource } from "../cluster/ClusterSource";
import { sanitizeTask } from "../cluster/sanitize";
import type { TaskInfo } from "../cluster/types";
import type { OverviewSection } from "../overview/section";
import { swarmSection } from "../overview/swarmSection";
import { FIXTURE_SECRETS, startDockerStub, stubRegistry } from "../test-support/dockerStub";
import { connect, textOf } from "../test-support/mcp";
import { TOOLS } from "./index";
import { opsGetService } from "./opsGetService";
import { opsListStacks } from "./opsListStacks";
import { opsListTasks } from "./opsListTasks";
import { overviewTool } from "./opsOverview";
import { opsRecentDeploys } from "./opsRecentDeploys";

let stub: Awaited<ReturnType<typeof startDockerStub>>;
before(async () => {
  stub = await startDockerStub();
});
after(() => stub.close());

const live = () => connect(TOOLS, { registry: stubRegistry(stub.url), cluster: createClusterSource });
const items = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent?.items as Array<Record<string, any>>;

test("no tool output contains a fixture secret", async () => {
  const { call } = await live();
  const calls: Array<[string, Record<string, unknown>]> = [
    ["ops_list_servers", {}],
    ["ops_overview", {}],
    ["ops_list_stacks", {}],
    ["ops_get_service", { server: "ovh-prod-1", service: "shop_web" }],
    ["ops_get_service", { server: "ovh-prod-1", service: "shop_worker" }],
    ["ops_list_tasks", { server: "ovh-prod-1", stack: "shop" }],
    ["ops_list_tasks", { server: "ovh-prod-1", service: "shop_web", state: "failed" }],
    ["ops_recent_deploys", { since: "30d" }],
  ];
  for (const [name, args] of calls) {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name}: ${textOf(r)}`);
    const out = JSON.stringify(r);
    for (const secret of FIXTURE_SECRETS) assert.ok(!out.includes(secret), `${name} leaked ${secret}`);
  }
});

test("ops_list_stacks resolves the project from the label, then the registry, and flags degraded stacks", async () => {
  const { call } = await live();
  const r = await call("ops_list_stacks");
  assert.deepEqual(items(r), [
    { server: "ovh-prod-1", stack: "obs", project: "observability-stack", services: 1, state: "running", degraded: [], images: ["grafana/alloy:v1.4.0"], last_update: "2026-04-01T10:00:00.000Z" },
    { server: "ovh-prod-1", stack: "shop", project: "barlito/shop", services: 2, state: "degraded", degraded: ["shop_web 0/1"], images: ["ghcr.io/barlito/shop:1.5.0"], last_update: "2026-06-01T11:42:10.552Z" },
  ]);
  assert.match(r.structuredContent?.summary as string, /^2 stacks, 1 degraded; failed: lab$/);
});

test("ops_list_stacks fails when the only targeted server is down", async () => {
  const { call } = await live();
  const r = await call("ops_list_stacks", { server: "lab" });
  assert.ok(r.isError);
  assert.match(textOf(r), /server_unreachable/);
});

test("ops_get_service returns the sanitized spec and the last tasks", async () => {
  const { call } = await live();
  const r = await call("ops_get_service", { server: "ovh-prod-1", service: "shop_web" });
  const [s] = items(r);
  assert.equal(r.structuredContent?.summary, "shop_web 0/1 running, last update rollback_completed");
  assert.deepEqual([s?.running, s?.desired, s?.image.tag, s?.previous_image.tag], [0, 1, "1.5.0", "1.4.2"]);
  assert.deepEqual(s?.tasks.map((t: TaskInfo) => [t.state, t.error, t.exit_code]), [["failed", "task: non-zero exit (1)", 1], ["failed", "task: non-zero exit (1)", 1]]);
  assert.deepEqual(r.structuredContent?.scope, { server: "ovh-prod-1", service: "shop_web" });
});

test("ops_get_service reports an unknown service", async () => {
  const { call } = await live();
  const r = await call("ops_get_service", { server: "ovh-prod-1", service: "nope" });
  assert.ok(r.isError);
  assert.match(textOf(r), /not_found/);
});

function tasksSource(count: number) {
  const names = new Map([["svc", "app_web"]]);
  const all = Array.from({ length: count }, (_, i) =>
    sanitizeTask({ ID: `t${String(i).padStart(3, "0")}`, ServiceID: "svc", Status: { State: "failed", Timestamp: new Date(Date.UTC(2026, 5, 1, 0, 0, count - i)).toISOString() } }, names, new Map()),
  );
  return { listTasks: async () => all };
}

test("ops_list_tasks needs a stack or a service", async () => {
  const { call } = await connect([opsListTasks]);
  const r = await call("ops_list_tasks", { server: "ovh-prod-1" });
  assert.ok(r.isError);
  assert.match(textOf(r), /invalid_arguments/);
});

test("ops_list_tasks caps at limit and pages with the cursor, newest first", async () => {
  const { call } = await connect([opsListTasks], { cluster: () => ({ info: async () => ({ reachable: true, swarm: true }), ...tasksSource(120) }) as never });
  const first = await call("ops_list_tasks", { server: "ovh-prod-1", service: "app_web", limit: 50 });
  assert.equal(items(first).length, 50);
  assert.equal(first.structuredContent?.truncated, true);
  const second = await call("ops_list_tasks", { server: "ovh-prod-1", service: "app_web", limit: 50, cursor: first.structuredContent?.next_cursor });
  assert.deepEqual([items(second)[0]?.id, items(second).length], ["t050", 50]);
  const last = await call("ops_list_tasks", { server: "ovh-prod-1", service: "app_web", limit: 50, cursor: second.structuredContent?.next_cursor });
  assert.deepEqual([items(last).length, last.structuredContent?.truncated, last.structuredContent?.next_cursor], [20, false, undefined]);
  const all = [...items(first), ...items(second), ...items(last)].map((t) => t.updated_at);
  assert.deepEqual(all, [...all].sort().reverse());
});

test("ops_list_tasks rejects a limit above 50 and a forged cursor", async () => {
  const { call } = await connect([opsListTasks], { cluster: () => ({ info: async () => ({ reachable: true, swarm: true }), ...tasksSource(3) }) as never });
  assert.ok((await call("ops_list_tasks", { server: "ovh-prod-1", service: "app_web", limit: 51 }).catch(() => ({ isError: true }))).isError);
  const r = await call("ops_list_tasks", { server: "ovh-prod-1", service: "app_web", cursor: "not-a-cursor!" });
  assert.match(textOf(r), /invalid_cursor/);
});

test("ops_list_tasks filters failed tasks of a stack end to end", async () => {
  const { call } = await live();
  const r = await call("ops_list_tasks", { server: "ovh-prod-1", stack: "shop", state: "failed" });
  assert.deepEqual(items(r).map((t) => [t.service, t.error]), [["shop_web", "task: non-zero exit (1)"], ["shop_web", "task: non-zero exit (1)"]]);
});

test("ops_recent_deploys lists updates in the window, newest first, with before/after", async () => {
  const { call } = await live();
  const narrow = await call("ops_recent_deploys");
  assert.deepEqual(items(narrow).map((d) => d.service), ["shop_web"]);
  const wide = await call("ops_recent_deploys", { since: "30d" });
  assert.deepEqual(items(wide).map((d) => d.service), ["shop_web", "shop_worker"]);
  assert.deepEqual(items(wide)[0], {
    server: "ovh-prod-1",
    service: "shop_web",
    stack: "shop",
    at: "2026-06-01T11:42:10.552Z",
    state: "rollback_completed",
    message: "rollback completed",
    image: "ghcr.io/barlito/shop:1.5.0",
    previous_image: "ghcr.io/barlito/shop:1.4.2",
  });
  const one = await call("ops_recent_deploys", { since: "30d", limit: 1 });
  assert.deepEqual([items(one).length, one.structuredContent?.truncated], [1, true]);
});

test("ops_overview composes the swarm section per server and isolates unreachable ones", async () => {
  const { call } = await live();
  const r = await call("ops_overview");
  const [prod, lab] = items(r);
  assert.deepEqual(prod?.swarm, {
    nodes: { total: 2, not_ready: ["ovh-prod-2"] },
    stacks: 2,
    degraded_services: [{ service: "shop_web", running: 0, desired: 1 }],
    failed_tasks_total: 3,
    failed_tasks: [
      { service: "shop_worker", error: "no suitable node (scheduling constraints not satisfied on 1 node)", at: "2026-06-01T11:59:01.000Z" },
      { service: "shop_web", error: "task: non-zero exit (1)", exit_code: 1, at: "2026-06-01T11:58:04.500Z" },
      { service: "shop_web", error: "task: non-zero exit (1)", exit_code: 1, at: "2026-06-01T11:57:04.500Z" },
    ],
  });
  assert.equal(prod?.errors, undefined);
  assert.match(lab?.swarm.error, /not implemented/);
  assert.match(r.structuredContent?.summary as string, /swarm: 1 degraded service, 3 failed tasks, 1 server unreachable/);
});

test("ops_overview only counts failed tasks inside the window", async () => {
  const { call } = await live();
  const r = await call("ops_overview", { server: "ovh-prod-1", since: "2026-06-01T11:58:30.000Z" });
  assert.equal(items(r)[0]?.swarm.failed_tasks_total, 1);
});

test("ops_overview: a failing or silent section is noted, the others still answer", async () => {
  const failing: OverviewSection<unknown> = {
    name: "logs",
    partSchema: z.unknown(),
    collect: async () => {
      throw new Error("loki down");
    },
    summarize: () => "unused",
  };
  const silent: OverviewSection<unknown> = { name: "metrics", partSchema: z.unknown(), collect: async () => new Map(), summarize: () => "metrics: ok" };
  const { call } = await connect([overviewTool([swarmSection, failing, silent])], { registry: stubRegistry(stub.url), cluster: createClusterSource });
  const r = await call("ops_overview", { server: "ovh-prod-1" });
  assert.ok(!r.isError);
  const [prod] = items(r);
  assert.ok(prod?.swarm.nodes);
  assert.deepEqual(prod?.errors, { logs: "loki down", metrics: "no data for this server" });
  assert.match(r.structuredContent?.summary as string, /logs: unavailable; metrics: ok/);
});

test("the Swarm tools are read-only and advertise the untrusted-data notice", async () => {
  const { client } = await connect([opsListStacks, opsGetService, opsRecentDeploys, opsListTasks]);
  for (const t of (await client.listTools()).tools) {
    assert.equal(t.annotations?.readOnlyHint, true);
    assert.match(t.description ?? "", /untrusted data/);
  }
});
