import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ToolError } from "../tools/contract";
import { startDockerStub } from "../test-support/dockerStub";
import { LocalDockerSource } from "./LocalDockerSource";

let stub: Awaited<ReturnType<typeof startDockerStub>>;
let source: LocalDockerSource;

before(async () => {
  stub = await startDockerStub();
  source = new LocalDockerSource(stub.url);
});
after(() => stub.close());

const lastRequest = (): string => stub.requests.at(-1) ?? "";
const filtersOf = (request: string): unknown => JSON.parse(new URL(request, "http://x").searchParams.get("filters") ?? "null");
const rejectsWith = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof ToolError && e.code === code);

test("listNodes maps the raw nodes", async () => {
  assert.deepEqual((await source.listNodes()).map((n) => [n.hostname, n.state, n.leader]), [["ovh-prod-1", "ready", true], ["ovh-prod-2", "down", false]]);
});

test("listServices asks for status and URL-encodes the stack filter", async () => {
  const services = await source.listServices({ stack: "shop" });
  assert.deepEqual(services.map((s) => s.name), ["shop_web", "shop_worker"]);
  assert.deepEqual(filtersOf(lastRequest()), { label: ["com.docker.stack.namespace=shop"] });
  assert.ok(!/[{}"\[\]]/.test(lastRequest()));
});

test("a stack name with reserved characters stays inside the filter", async () => {
  await source.listServices({ stack: 'a&b"c' });
  assert.deepEqual(filtersOf(lastRequest()), { label: ['com.docker.stack.namespace=a&b"c'] });
  assert.ok(!lastRequest().includes("a&b"));
});

test("the service filter is an exact match although Docker matches substrings", async () => {
  assert.deepEqual((await source.listServices({ service: "shop_web" })).map((s) => s.name), ["shop_web"]);
  assert.deepEqual(await source.listServices({ service: "shop_w" }), []);
  assert.deepEqual(filtersOf(lastRequest()), { name: ["shop_w"] });
});

test("listStacks derives the stacks from the service labels", async () => {
  assert.deepEqual((await source.listStacks()).map((s) => s.name), ["obs", "shop"]);
});

test("getService merges the inspect with the running count", async () => {
  const s = await source.getService("shop_web");
  assert.deepEqual([s.name, s.running, s.desired, s.update_status?.state], ["shop_web", 0, 1, "rollback_completed"]);
  assert.match(lastRequest(), /^\/services\?status=true&filters=/);
});

test("an unknown service is not_found", async () => {
  await rejectsWith(source.getService("nope"), "not_found");
  await rejectsWith(source.serviceUpdateHistory("nope"), "not_found");
  await rejectsWith(source.listTasks({ service: "nope" }), "not_found");
});

test("serviceUpdateHistory gives the image before and after", async () => {
  const u = await source.serviceUpdateHistory("shop_web");
  assert.deepEqual([u.image.tag, u.previous_image?.tag, u.update_status?.state], ["1.5.0", "1.4.2", "rollback_completed"]);
});

test("listTasks scopes by the service ids of the stack and sorts newest first", async () => {
  const tasks = await source.listTasks({ stack: "shop" });
  assert.deepEqual(tasks.map((t) => t.id), ["t4sk0000000000000000rej01", "t4sk0000000000000000fail1", "t4sk0000000000000000fail0", "t4sk00000000000000000ok01"]);
  assert.ok(lastRequest().startsWith("/tasks?filters="));
  assert.deepEqual(filtersOf(lastRequest()), { service: ["svc-shop-web", "svc-shop-worker"] });
});

test("listTasks filters by service and by state", async () => {
  assert.deepEqual((await source.listTasks({ service: "shop_web", state: "failed" })).map((t) => t.exit_code), [1, 1]);
  assert.deepEqual(await source.listTasks({ stack: "nope" }), []);
});

test("an unreachable proxy maps to server_unreachable", async () => {
  await rejectsWith(new LocalDockerSource("tcp://127.0.0.1:1").listNodes(), "server_unreachable");
});

test("a proxy refusing an endpoint maps to server_unreachable with the status", async () => {
  const forbidden = new LocalDockerSource(stub.url.replace("tcp://", "http://") + "/nested");
  await assert.rejects(forbidden.listNodes(), (e: unknown) => e instanceof ToolError && e.code === "server_unreachable" && /HTTP 403/.test(e.message));
});

test("an aborted signal cancels the call", async () => {
  await rejectsWith(source.listNodes({ signal: AbortSignal.abort() }), "server_unreachable");
});
