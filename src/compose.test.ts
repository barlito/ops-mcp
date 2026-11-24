import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

interface Compose {
  secrets: Record<string, unknown>;
  services: Record<string, { secrets?: Array<{ source: string; target: string }>; environment?: string[] }>;
}
const load = (file: string): Compose => parse(readFileSync(join(process.cwd(), file), "utf8")) as Compose;
const local = load("docker-compose.yaml");
const prod = load("docker-compose-prod.yml");
const mounted = (c: Compose): string[] => (c.services["ops-mcp"]?.secrets ?? []).map((s) => `${s.source}:${s.target}`).sort();

test("local and prod compose declare and mount the same secrets", () => {
  assert.deepEqual(Object.keys(prod.secrets).sort(), Object.keys(local.secrets).sort());
  assert.deepEqual(mounted(prod), mounted(local));
  assert.ok(mounted(prod).includes("gh_deployments_token:gh_deployments_token"));
});

test("every *_FILE variable of the service points at a mounted secret", () => {
  for (const compose of [local, prod]) {
    const targets = new Set(mounted(compose).map((m) => m.split(":")[1]));
    const files = (compose.services["ops-mcp"]?.environment ?? []).flatMap((e) => /^[A-Z_]+_FILE=\/run\/secrets\/(.+)$/.exec(e)?.[1] ?? []);
    assert.ok(files.length >= 4);
    for (const f of files) assert.ok(targets.has(f), f);
  }
});
