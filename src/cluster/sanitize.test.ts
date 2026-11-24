import { test } from "node:test";
import assert from "node:assert/strict";
import { filterLabels, parseImage, redactArgs, redactText, sanitizeNode, sanitizeServiceDetail, sanitizeServiceSummary, sanitizeTask, sanitizeUpdate, traefikRoutes } from "./sanitize";
import { groupStacks, isDegraded } from "./swarm";
import { FIXTURE_SECRETS, rawFixtures } from "../test-support/dockerStub";

const names = new Map(rawFixtures.services.map((s) => [s.ID, s.Spec?.Name ?? ""]));
const nodes = new Map(rawFixtures.nodes.map((n) => [n.ID, n.Description?.Hostname ?? ""]));

test("no sanitizer output contains a fixture secret", () => {
  const outputs = [
    rawFixtures.nodes.map(sanitizeNode),
    rawFixtures.services.map((s) => sanitizeServiceSummary(s)),
    sanitizeServiceDetail(rawFixtures.inspect, { RunningTasks: 0, DesiredTasks: 1 }),
    sanitizeUpdate(rawFixtures.inspect),
    rawFixtures.tasks.map((t) => sanitizeTask(t, names, nodes)),
    groupStacks(rawFixtures.services.map((s) => sanitizeServiceSummary(s))),
  ];
  const json = JSON.stringify(outputs);
  for (const secret of FIXTURE_SECRETS) assert.ok(!json.includes(secret), `leaked ${secret}`);
});

test("the fixtures really contain the secrets the sanitizer must drop", () => {
  const raw = JSON.stringify(rawFixtures);
  for (const secret of FIXTURE_SECRETS.filter((s) => s !== "internal.note")) assert.ok(raw.includes(secret), `fixture lacks ${secret}`);
});

test("service detail keeps names of secrets and configs, never their ids", () => {
  const d = sanitizeServiceDetail(rawFixtures.inspect);
  assert.deepEqual(d.secrets, ["shop_db_password"]);
  assert.deepEqual(d.configs, ["shop_ini_v3"]);
});

test("service detail maps the spec to explicit fields", () => {
  const d = sanitizeServiceDetail(rawFixtures.inspect, { RunningTasks: 0, DesiredTasks: 1 });
  assert.deepEqual(d.image, { name: "ghcr.io/barlito/shop", tag: "1.5.0", digest: "sha256:111111111111" });
  assert.deepEqual(d.previous_image, { name: "ghcr.io/barlito/shop", tag: "1.4.2", digest: "sha256:222222222222" });
  assert.deepEqual([d.mode, d.desired, d.running, d.stack], ["replicated", 1, 0, "shop"]);
  assert.deepEqual(d.update_status, { state: "rollback_completed", message: "rollback completed", started_at: "2026-06-01T11:40:02.001Z", completed_at: "2026-06-01T11:42:10.552Z" });
  assert.deepEqual(d.constraints, ["node.role == worker"]);
  assert.deepEqual(d.limits, { nano_cpus: 500000000, memory_bytes: 536870912 });
  assert.deepEqual(d.reservations, { memory_bytes: 134217728 });
  assert.deepEqual(d.ports, [{ protocol: "tcp", target: 8080, published: 8080, mode: "ingress" }]);
  assert.deepEqual(d.networks, ["net-shop-def"]);
  assert.deepEqual(d.routes, [{ router: "shop", hosts: ["shop.barlito.fr", "www.shop.barlito.fr"] }]);
  assert.deepEqual(d.args, ["--port=8080", "--password=[REDACTED]", "--token", "[REDACTED]"]);
});

test("labels are whitelisted: com.docker.* and fr.barlito.* only", () => {
  assert.deepEqual(
    filterLabels({ "com.docker.stack.namespace": "shop", "fr.barlito.repo": "barlito/shop", "traefik.enable": "true", "traefik.http.middlewares.a.basicauth.users": "admin:$apr1$x", "my.com.docker.x": "no" }),
    { "com.docker.stack.namespace": "shop", "fr.barlito.repo": "barlito/shop" },
  );
});

test("traefik: only router names and hosts survive", () => {
  assert.deepEqual(
    traefikRoutes({
      "traefik.http.routers.api.rule": "Host(`a.example.com`) && PathPrefix(`/v1`)",
      "traefik.http.routers.api.middlewares": "auth",
      "traefik.http.middlewares.auth.basicauth.users": "admin:$apr1$hash",
      "traefik.enable": "true",
    }),
    [{ router: "api", hosts: ["a.example.com"] }],
  );
});

test("redactText masks url credentials and secret-looking key=value pairs", () => {
  assert.equal(redactText("psql postgresql://app:fake-pass@db:5432/app"), "psql postgresql://[REDACTED]@db:5432/app");
  assert.equal(redactText("run --api-key=zzz TOKEN=abc plain=ok"), "run --api-key=[REDACTED] TOKEN=[REDACTED] plain=ok");
  assert.equal(redactText("task: non-zero exit (1)"), "task: non-zero exit (1)");
});

test("redactArgs masks the value following a bare sensitive flag", () => {
  assert.deepEqual(redactArgs(["serve", "--password", "hunter2", "--port", "80"]), ["serve", "--password", "[REDACTED]", "--port", "80"]);
});

test("parseImage handles tags, digests and registry ports", () => {
  assert.deepEqual(parseImage("registry.example.com:5000/team/app"), { name: "registry.example.com:5000/team/app" });
  assert.deepEqual(parseImage("registry.example.com:5000/team/app:edge"), { name: "registry.example.com:5000/team/app", tag: "edge" });
  assert.deepEqual(parseImage("alpine@sha256:0123456789abcdef0123"), { name: "alpine", digest: "sha256:0123456789ab" });
});

test("tasks carry the error, exit code and resolved names, newest data first-class", () => {
  const t = sanitizeTask(rawFixtures.tasks[0]!, names, nodes);
  assert.deepEqual(t, {
    id: "t4sk0000000000000000fail1",
    service: "shop_web",
    slot: 1,
    node: "ovh-prod-1",
    image: "ghcr.io/barlito/shop:1.5.0",
    state: "failed",
    desired_state: "shutdown",
    error: "task: non-zero exit (1)",
    exit_code: 1,
    created_at: "2026-06-01T11:58:00.000Z",
    updated_at: "2026-06-01T11:58:04.500Z",
  });
});

test("nodes drop TLS info", () => {
  assert.deepEqual(sanitizeNode(rawFixtures.nodes[1]!), { id: "node2worker00000000000000b", hostname: "ovh-prod-2", role: "worker", availability: "active", state: "down", leader: false });
});

test("degraded means running < desired, except for job modes", () => {
  const [web, worker, alloy, loose] = rawFixtures.services.map((s) => sanitizeServiceSummary(s));
  assert.deepEqual([web, worker, alloy, loose].map((s) => isDegraded(s!)), [true, false, false, false]);
  assert.equal(isDegraded({ ...web!, mode: "replicated-job" }), false);
  assert.equal(isDegraded({ ...alloy!, running: 1 }), true);
});

test("groupStacks ignores services outside a stack and sorts by name", () => {
  assert.deepEqual(groupStacks(rawFixtures.services.map((s) => sanitizeServiceSummary(s))).map((s) => [s.name, s.services.length]), [["obs", 1], ["shop", 2]]);
});
