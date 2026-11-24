import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServiceSummary } from "../cluster/types";
import { GitHubClient, type GhDeployment, type GitHubApi } from "../github/GitHubClient";
import { apiDeployment, apiStatus, ghDeployment, GH_TOKEN, startGitHubStub } from "../test-support/github";
import { connect, stubSource, textOf } from "../test-support/mcp";
import { ToolError } from "./contract";
import { opsRecentDeploys } from "./opsRecentDeploys";

const service = (name: string, repo: string | undefined, tag: string, updated: string, stack = name.split("_")[0]!): ServiceSummary => ({
  id: name,
  name,
  stack,
  mode: "replicated",
  desired: 1,
  running: 1,
  image: { name: `barlito/${stack}`, tag },
  labels: repo ? { "fr.barlito.repo": repo } : {},
  created_at: "2026-05-01T00:00:00.000Z",
  updated_at: updated,
});

const services = [
  service("carapp_php", "barlito/carapp", "v1.4.3", "2026-06-01T11:45:00.000Z"),
  service("carapp_worker", "barlito/carapp", "v1.4.3", "2026-06-01T11:46:00.000Z"),
  service("shop_web", "barlito/shop", "v2.0.1", "2026-06-01T11:30:00.000Z"),
  service("obs_alloy", undefined, "v1.0.0", "2026-06-01T11:20:00.000Z"),
];

const cluster = () =>
  stubSource({
    listServices: async () => services,
    serviceUpdateHistory: async (id) => {
      const s = services.find((x) => x.id === id)!;
      return { service: s.name, stack: s.stack, created_at: s.created_at, updated_at: s.updated_at, update_status: { state: "completed" }, image: s.image, ...(id === "carapp_php" ? { previous_image: { name: s.image.name, tag: "v1.4.1" } } : {}) };
    },
  });

const deployments: Record<string, GhDeployment[]> = {
  "barlito/carapp": [
    ghDeployment({ id: 11, ref: "v1.4.4", created_at: "2026-06-01T11:50:00Z", status: "failure" }),
    ghDeployment({ id: 10, ref: "v1.4.3", created_at: "2026-06-01T11:40:00Z" }),
    ghDeployment({ id: 12, ref: "v1.4.1", created_at: "2026-06-01T11:10:00Z" }),
    ghDeployment({ id: 1, ref: "v1.4.2", created_at: "2026-05-20T10:00:00Z", status: "inactive" }),
  ],
  "barlito/shop": [ghDeployment({ id: 20, ref: "main", created_at: "2026-06-01T11:25:00Z", creator: "github-actions" })],
  "observability-stack": [],
};
const github: GitHubApi = {
  recentDeployments: async (repo) => deployments[repo] ?? [],
  deployment: async () => ghDeployment({ id: 1 }),
};

type Item = Record<string, any>;
const run = async (gh: GitHubApi | undefined, args: Record<string, unknown> = {}) => {
  const { call } = await connect([opsRecentDeploys], { cluster, github: gh });
  const r = await call("ops_recent_deploys", { server: "ovh-prod-1", ...args });
  assert.ok(!r.isError, JSON.stringify(r.content));
  return r;
};

test("attaches the GitHub deployment with the same tag; Swarm updates come first, then deployments with no matching Swarm update", async () => {
  const r = await run(github);
  const items = r.structuredContent?.items as Item[];
  assert.deepEqual(items.map((i) => [i.service, i.repo, i.github?.deployment_id, i.github?.kind, i.github_only ?? false]), [
    ["carapp_worker", undefined, 10, "deploy", false],
    ["carapp_php", undefined, 10, "deploy", false],
    ["shop_web", undefined, 20, "rollback", false],
    ["obs_alloy", undefined, undefined, undefined, false],
    [undefined, "barlito/carapp", 11, "deploy", true],
  ]);
  assert.deepEqual(items.find((i) => i.service === "carapp_php")?.github, {
    deployment_id: 10,
    kind: "deploy",
    tag: "v1.4.3",
    sha: "9fceb02",
    status: "success",
    run_url: "https://github.com/barlito/carapp/actions/runs/10",
    creator: "github-actions[bot]",
    created_at: "2026-06-01T11:40:00Z",
  });
  const only = items[4]!;
  assert.deepEqual([only.github.tag, only.github.status, only.image, only.stack], ["v1.4.4", "failure", undefined, "carapp"]);
  assert.deepEqual(items.find((i) => i.service === "shop_web")?.github, { ...items[2]!.github, tag: "v2.0.1", creator: "github-actions", sha: "9fceb02", kind: "rollback" });
  assert.equal(r.structuredContent?.summary, "4 service updates in the window, 1 GitHub deployment without a matching Swarm update (1 failed)");
  assert.match(textOf(r), /barlito\/carapp \(no matching current Swarm update\)/);
});

test("the previous image tag counts as reached Swarm: no github_only entry for it", async () => {
  const r = await run(github);
  assert.ok(!(r.structuredContent?.items as Item[]).some((i) => i.github?.deployment_id === 12));
});

test("github_only items never evict Swarm updates from the limit", async () => {
  const r = await run(github, { limit: 2 });
  const items = r.structuredContent?.items as Item[];
  assert.deepEqual(items.map((i) => i.service), ["carapp_worker", "carapp_php", undefined]);
  assert.equal(r.structuredContent?.truncated, true);
});

test("repositories are only queried for services that resolve to one, and the budget and repo cap are reported", async () => {
  const calls: string[] = [];
  const spy: GitHubApi = { ...github, recentDeployments: async (repo) => (calls.push(repo), []) };
  const { call } = await connect([opsRecentDeploys], { cluster: () => stubSource({ listServices: async () => [service("x_web", undefined, "v1", "2026-06-01T11:30:00.000Z", "x")], serviceUpdateHistory: async () => ({ service: "x_web", created_at: "", updated_at: "2026-06-01T11:30:00.000Z", image: { name: "x", tag: "v1" } }) }), github: spy });
  await call("ops_recent_deploys", { server: "ovh-prod-1" });
  assert.deepEqual(calls, []);

  const many = Array.from({ length: 25 }, (_, i) => service(`s${i}_web`, `barlito/s${i}`, "v1", "2026-06-01T11:30:00.000Z", `s${i}`));
  calls.length = 0;
  const wide = await connect([opsRecentDeploys], { cluster: () => stubSource({ listServices: async () => many, serviceUpdateHistory: async (id) => ({ service: id, created_at: "", updated_at: "2026-06-01T11:30:00.000Z", image: { name: "x", tag: "v1" } }) }), github: spy });
  const r = await wide.call("ops_recent_deploys", { server: "ovh-prod-1" });
  assert.equal(calls.length, 20);
  assert.match(r.structuredContent?.summary as string, /; 5 repositories not queried \(limit 20\)$/);
});

test("the request budget of one call is shared by every repository and reported", async () => {
  let taken = 0;
  const greedy: GitHubApi = {
    ...github,
    recentDeployments: async (_repo, _w, opts) => {
      while (opts?.budget?.take()) taken++;
      throw new ToolError("backend_unavailable", "GitHub request budget of this call reached.");
    },
  };
  const r = await run(greedy);
  assert.equal(taken, 30);
  assert.match(r.structuredContent?.summary as string, /GitHub request budget \(30\) reached, results partial$/);
});

test("Swarm fields are unchanged and GitHub is additive: without a client the output has no github field", async () => {
  const r = await run(undefined);
  const items = r.structuredContent?.items as Item[];
  assert.equal(items.length, 4);
  assert.ok(items.every((i) => i.github === undefined && i.github_only === undefined));
  assert.deepEqual(items[0], { server: "ovh-prod-1", service: "carapp_worker", stack: "carapp", at: "2026-06-01T11:46:00.000Z", state: "completed", image: "barlito/carapp:v1.4.3" });
  assert.equal(r.structuredContent?.summary, "4 service updates in the window");
});

test("a failing GitHub lookup only costs a note; other repos still fuse", async () => {
  const flaky: GitHubApi = { ...github, recentDeployments: async (repo, since) => (repo === "barlito/shop" ? Promise.reject(new ToolError("backend_auth", "GitHub refused the token")) : github.recentDeployments(repo, since)) };
  const r = await run(flaky);
  const items = r.structuredContent?.items as Item[];
  assert.equal(items.find((i) => i.service === "carapp_php")?.github?.deployment_id, 10);
  assert.equal(items.find((i) => i.service === "shop_web")?.github, undefined);
  assert.match(r.structuredContent?.summary as string, /; GitHub unavailable \(backend_auth\)$/);
});

test("with the real client against a stub GitHub, no output or audit row holds the token", async () => {
  const stub = await startGitHubStub({
    "/repos/barlito/carapp/deployments": { body: [apiDeployment(10, "v1.4.3", "2026-06-01T11:40:00Z")] },
    "/repos/barlito/carapp/deployments/10/statuses": { body: [apiStatus("success", 902, "2026-06-01T11:41:00Z")] },
    "/repos/barlito/shop/deployments": { status: 401, body: { message: `Bad credentials ${GH_TOKEN}` } },
    "/repos/barlito/observability-stack/deployments": { body: [] },
  });
  try {
    const { call, stores } = await connect([opsRecentDeploys], { cluster, github: new GitHubClient(GH_TOKEN, { baseUrl: stub.url }) });
    const r = await call("ops_recent_deploys", { server: "ovh-prod-1" });
    assert.equal(((r.structuredContent?.items as Item[]).find((i) => i.service === "carapp_php")?.github as Item).run_url, "https://github.com/barlito/carapp/actions/runs/902");
    assert.match(r.structuredContent?.summary as string, /GitHub unavailable \(backend_auth\)/);
    const logged = JSON.stringify([r, stores.audit.query({}).rows]);
    assert.ok(!logged.includes(GH_TOKEN) && !logged.includes("Bad credentials"));
  } finally {
    await stub.close();
  }
});
