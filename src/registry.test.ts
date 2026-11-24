import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, REGISTRY_YAML, writeTemp } from "./test-support/fixtures";
import { loadRegistry, parseRegistry, RegistryError } from "./registry";

after(cleanup);

test("a valid registry parses with defaults", () => {
  const r = parseRegistry(REGISTRY_YAML);
  assert.equal(r.servers.length, 2);
  assert.deepEqual(r.servers[0]?.source, { type: "local", url: "tcp://dockerproxy-ops:2375" });
  assert.deepEqual(r.stack_projects, { obs: "observability-stack" });
  const minimal = parseRegistry("tenants: [{slug: t}]\nservers: [{slug: s, env: production, kind: swarm, tenant: t, source: {type: local, url: 'http://x:1'}}]");
  assert.deepEqual(minimal.stack_projects, {});
});

test("the committed registries are valid", () => {
  for (const f of ["registry.yaml", "registry.local.yaml"]) {
    const r = loadRegistry(join(process.cwd(), "config", f));
    assert.ok(r.servers.length >= 1, f);
  }
  assert.equal(parseRegistry(readFileSync(join(process.cwd(), "config", "registry.local.yaml"), "utf8")).servers[0]?.slug, "local");
});

function invalid(yaml: string, expected: RegExp): void {
  assert.throws(() => parseRegistry(yaml, "registry test.yaml"), (err: unknown) => err instanceof RegistryError && /^Invalid registry test\.yaml/.test(err.message) && expected.test(err.message));
}

const base = (server: string, extra = ""): string => `tenants: [{slug: t}]\n${extra}servers:\n  - { ${server} }\n`;
const ok = "slug: s, env: production, kind: swarm, tenant: t, source: {type: local, url: 'tcp://x:1'}";

test("invalid registries fail with a precise message", () => {
  invalid("servers: []", /tenants/);
  invalid("tenants: [{slug: t}]\nservers: []", /servers/);
  invalid(base(ok.replace("kind: swarm", "kind: nomad")), /servers\.0\.kind/);
  invalid(base(ok.replace("tenant: t", "tenant: nope")), /unknown tenant "nope"/);
  invalid(base(ok.replace("slug: s", "slug: BAD_SLUG")), /servers\.0\.slug.*slug/);
  invalid(base(ok.replace("tcp://x:1", "ftp://x")), /servers\.0\.source\.url/);
  invalid(base(ok.replace("type: local", "type: ssh")), /servers\.0\.source/);
  invalid(base(ok + ", extra: 1"), /servers\.0/);
  invalid(base(ok, "stack_projects: {a: 3}\n"), /stack_projects/);
  invalid(`tenants: [{slug: t}, {slug: t}]\nservers:\n  - { ${ok} }\n`, /duplicate slug "t"/);
  invalid(`tenants: [{slug: t}]\nservers:\n  - { ${ok} }\n  - { ${ok} }\n`, /duplicate slug "s"/);
  invalid("tenants: [", /not valid YAML/);
  invalid("just a string", /\(root\)/);
});

test("agent sources are accepted by the schema", () => {
  const r = parseRegistry(base("slug: a, env: production, kind: compose, tenant: t, source: {type: agent}"));
  assert.equal(r.servers[0]?.source.type, "agent");
});

test("loadRegistry fails fast on a missing path or file", () => {
  assert.throws(() => loadRegistry(undefined), /REGISTRY_PATH/);
  assert.throws(() => loadRegistry("/nonexistent/registry.yaml"), /Cannot read registry/);
  assert.equal(loadRegistry(writeTemp("r.yaml", REGISTRY_YAML)).tenants[0]?.slug, "barlito");
});
