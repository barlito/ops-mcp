import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServiceSummary } from "../cluster/types";
import { GitHubClient, type GhDeployment, type GitHubApi } from "../github/GitHubClient";
import { apiDeployment, apiStatus, ghDeployment, GH_TOKEN, startGitHubStub } from "../test-support/github";
import { connect, stubSource } from "../test-support/mcp";
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
      return { service: s.name, stack: s.stack, created_at: s.created_at, updated_at: s.updated_at, update_status: { state: "completed" }, image: s.image };
    },
  });

const deployments: Record<string, GhDeployment[]> = {
  "barlito/carapp": [
    ghDeployment({ id: 11, ref: "v1.4.4", created_at: "2026-06-01T11:50:00Z", status: "failure" }),
    ghDeployment({ id: 10, ref: "v1.4.3", created_at: "2026-06-01T11:40:00Z" }),
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

test("attaches the GitHub deployment with the same tag, lists the ones that never reached Swarm and the rollbacks", async () => {
  const r = await run(github);
  const items = r.structuredContent?.items as Item[];
  assert.deepEqual(items.map((i) => [i.service, i.github?.deployment_id, i.github?.kind, i.github_only ?? false]), [
    ["carapp", 11, "deploy", true],
    ["carapp_worker", 10, "deploy", false],
    ["carapp_php", 10, "deploy", false],
    ["shop_web", 20, "rollback", false],
    ["obs_alloy", undefined, undefined, false],
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
  assert.deepEqual(items.find((i) => i.service === "carapp")?.github, { ...items[0]!.github, tag: "v1.4.4", status: "failure" });
  assert.equal(items[0]!.image, undefined);
  assert.deepEqual(items.find((i) => i.service === "shop_web")?.github, { ...items[3]!.github, tag: "v2.0.1", creator: "github-actions", sha: "9fceb02", kind: "rollback" });
  assert.match(r.structuredContent?.summary as string, /^4 service updates in the window, 1 GitHub deployment without a Swarm update$/);
  assert.ok(Buffer.byteLength(r.structuredContent?.summary as string) <= 240);
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
