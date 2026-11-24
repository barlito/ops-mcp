import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRegistry } from "../registry";
import { testRegistry } from "../test-support/fixtures";
import { ghDeployment } from "../test-support/github";
import { linkOf, matchDeployment, repoName, resolveRepo, resolveRepoRef } from "./fuse";

const at = (iso: string) => Date.parse(iso);

test("the repo is the fr.barlito.repo label, else the registry stack_projects entry, else the stack name as a guess", () => {
  const registry = testRegistry();
  assert.equal(resolveRepo({ labels: { "fr.barlito.repo": "barlito/carapp" }, stack: "obs" }, registry), "barlito/carapp");
  assert.equal(resolveRepo({ labels: {}, stack: "obs" }, registry), "observability-stack");
  assert.deepEqual(resolveRepoRef({ labels: { "fr.barlito.repo": "barlito/carapp" }, stack: "obs" }, registry), { repo: "barlito/carapp", guess: false });
  assert.deepEqual(resolveRepoRef({ labels: {}, stack: "obs" }, registry), { repo: "observability-stack", guess: false });
  assert.deepEqual(resolveRepoRef({ labels: {}, stack: "shop" }, registry), { repo: "shop", guess: true });
  assert.equal(resolveRepo({ labels: {}, stack: "bad stack/../x" }, registry), undefined);
  assert.equal(resolveRepo({ labels: {}, stack: ".." }, registry), undefined);
  assert.equal(resolveRepo({ labels: {} }, registry), undefined);
  assert.equal(resolveRepo({ labels: {} }, parseRegistry("tenants: [{slug: a}]\nservers: [{slug: s, env: e, kind: swarm, tenant: a, source: {type: local, url: 'tcp://x:1'}}]\nstack_projects: {constructor: boom}")), undefined);
  assert.equal(repoName("barlito/carapp"), "carapp");
  assert.equal(repoName("carapp"), "carapp");
});

test("matches the deployment whose tag equals the image tag, nearest in time, ignoring a leading v", () => {
  const old = ghDeployment({ id: 1, ref: "v1.4.3", created_at: "2026-05-01T10:00:00Z" });
  const recent = ghDeployment({ id: 2, ref: "v1.4.3", created_at: "2026-06-01T11:40:00Z" });
  const other = ghDeployment({ id: 3, ref: "v1.4.4", created_at: "2026-06-01T11:41:00Z" });
  const facts = { at: at("2026-06-01T11:45:00Z"), tags: ["1.4.3"] };
  assert.equal(matchDeployment(facts, [old, other, recent])?.id, 2);
  assert.equal(matchDeployment({ ...facts, tags: ["1.9.9"] }, [old, other, recent]), undefined);
});

test("after an automatic rollback the failed image tag still matches its deployment", () => {
  const failed = ghDeployment({ id: 5, ref: "v1.5.0", status: "success" });
  assert.equal(matchDeployment({ at: at("2026-06-01T11:50:00Z"), tags: ["v1.4.2", "v1.5.0"] }, [failed])?.id, 5);
});

test("a swarm-rollback deployment (ref is the default branch) matches by time and takes the Swarm tag", () => {
  const rollback = ghDeployment({ id: 9, ref: "main", created_at: "2026-06-01T11:40:00Z", creator: "github-actions" });
  const facts = { at: at("2026-06-01T11:43:00Z"), tags: ["v1.4.2"] };
  const d = matchDeployment(facts, [rollback])!;
  assert.deepEqual(linkOf(d, "v1.4.2"), { deployment_id: 9, kind: "rollback", tag: "v1.4.2", sha: "9fceb02", status: "success", run_url: "https://github.com/barlito/carapp/actions/runs/9", creator: "github-actions", created_at: "2026-06-01T11:40:00Z" });
  assert.equal(matchDeployment({ at: at("2026-06-01T13:00:00Z"), tags: ["v1.4.2"] }, [rollback]), undefined);
  assert.equal(linkOf(d).tag, undefined);
});

test("v1.0.0, v1.1.0, then a rollback to v1.0.0: the update links to the rollback deployment, not the old tagged one", () => {
  const v100 = ghDeployment({ id: 1, ref: "v1.0.0", created_at: "2026-06-01T11:20:00Z" });
  const v110 = ghDeployment({ id: 2, ref: "v1.1.0", created_at: "2026-06-01T11:30:00Z" });
  const rollback = ghDeployment({ id: 3, ref: "main", created_at: "2026-06-01T11:40:00Z", creator: "github-actions" });
  const d = matchDeployment({ at: at("2026-06-01T11:41:00Z"), tags: ["v1.0.0"] }, [v100, v110, rollback])!;
  assert.deepEqual([d.id, linkOf(d, "v1.0.0").kind, linkOf(d, "v1.0.0").tag], [3, "rollback", "v1.0.0"]);
});

test("a tagged deployment is only matched when created shortly before the update", () => {
  const old = ghDeployment({ id: 1, ref: "v1.0.0", created_at: "2026-06-01T09:00:00Z" });
  assert.equal(matchDeployment({ at: at("2026-06-01T11:41:00Z"), tags: ["v1.0.0"] }, [old]), undefined);
});
