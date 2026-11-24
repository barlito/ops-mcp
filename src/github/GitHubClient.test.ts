import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { ToolError } from "../tools/contract";
import { writeTemp } from "../test-support/fixtures";
import { apiDeployment, apiStatus, GH_TOKEN, startGitHubStub } from "../test-support/github";
import { GitHubClient, githubFromEnv, RequestBudget } from "./GitHubClient";

const T0 = "2026-06-01T11:40:00Z";
const since = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-02T00:00:00Z") };

const routes = {
  "/repos/barlito/carapp/deployments": { body: [apiDeployment(2, "v1.4.3", T0), apiDeployment(1, "v1.4.2", "2026-05-20T10:00:00Z")] },
  "/repos/barlito/carapp/deployments/2/statuses": { body: [apiStatus("success", 902, T0), apiStatus("in_progress", 902, T0)] },
  "/repos/barlito/carapp/deployments/1/statuses": { body: [apiStatus("inactive", 901, T0)] },
};

test("lists the production deployments of the window with their latest status, sends the token", async () => {
  const stub = await startGitHubStub(routes);
  try {
    const list = await new GitHubClient(GH_TOKEN, { baseUrl: stub.url }).recentDeployments("carapp", since);
    assert.deepEqual(list, [{ id: 2, ref: "v1.4.3", sha: "9fceb02d0ae598e95dc970b74767f19372d61af8", created_at: T0, creator: "github-actions[bot]", status: "success", run_url: "https://github.com/barlito/carapp/actions/runs/902" }]);
    assert.match(stub.seen[0]!.path, /^\/repos\/barlito\/carapp\/deployments\?environment=production&per_page=\d+$/);
    assert.equal(stub.seen[0]!.headers.authorization, `Bearer ${GH_TOKEN}`);
  } finally {
    await stub.close();
  }
});

test("a failure status is reported as is, a single deployment is fetched by id", async () => {
  const stub = await startGitHubStub({
    "/repos/acme/web/deployments/7": { body: apiDeployment(7, "main", T0) },
    "/repos/acme/web/deployments/7/statuses": { body: [apiStatus("failure", 77, T0)] },
  });
  try {
    const d = await new GitHubClient(GH_TOKEN, { baseUrl: stub.url }).deployment("acme/web", 7);
    assert.deepEqual([d.id, d.ref, d.status, d.run_url], [7, "main", "failure", "https://github.com/barlito/carapp/actions/runs/77"]);
  } finally {
    await stub.close();
  }
});

test("answers are cached, then revalidated with the ETag", async () => {
  let hits = 0;
  const stub = await startGitHubStub({
    ...routes,
    "/repos/barlito/carapp/deployments": (seen) => (hits++, seen.headers["if-none-match"] === '"abc"' ? { status: 304 } : { body: routes["/repos/barlito/carapp/deployments"].body, headers: { etag: '"abc"' } }),
  });
  try {
    const client = new GitHubClient(GH_TOKEN, { baseUrl: stub.url, cacheMs: 40 });
    await client.recentDeployments("carapp", since);
    await client.recentDeployments("carapp", since);
    assert.equal(hits, 1);
    await new Promise((r) => setTimeout(r, 60));
    const again = await client.recentDeployments("carapp", since);
    assert.equal(hits, 2);
    assert.equal(again[0]?.id, 2);
  } finally {
    await stub.close();
  }
});

test("401, 403 and rate limits become distinct errors that never echo the upstream body", async () => {
  const leak = `Bad credentials ${GH_TOKEN}`;
  const stub = await startGitHubStub({
    "/repos/barlito/a/deployments": { status: 401, body: { message: leak } },
    "/repos/barlito/b/deployments": { status: 403, body: { message: leak }, headers: { "x-ratelimit-remaining": "4990" } },
    "/repos/barlito/c/deployments": { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } },
    "/repos/barlito/e/deployments": { status: 403, body: { message: "secondary rate limit" }, headers: { "retry-after": "60", "x-ratelimit-remaining": "4990" } },
    "/repos/barlito/f/deployments": { status: 403, body: { message: "abuse" } },
    "/repos/barlito/d/deployments": { status: 500, body: { message: leak } },
  });
  try {
    const client = new GitHubClient(GH_TOKEN, { baseUrl: stub.url });
    const code = async (repo: string): Promise<[string, string]> => client.recentDeployments(repo, since).then(() => ["ok", ""], (e: ToolError) => [e.code, e.message]);
    const results = await Promise.all(["a", "b", "c", "d", "missing", "e", "f"].map(code));
    assert.deepEqual(results.map(([c]) => c), ["backend_auth", "backend_auth", "backend_unavailable", "backend_unavailable", "not_found", "backend_unavailable", "backend_unavailable"]);
    for (const i of [2, 5, 6]) assert.match(results[i]![1], /rate limit/);
    for (const [, message] of results) assert.ok(!message.includes("Bad credentials") && !message.includes(GH_TOKEN));
  } finally {
    await stub.close();
  }
});

test("a slow GitHub times out and a caller signal cancels", async () => {
  const stub = await startGitHubStub({ "/repos/barlito/slow/deployments": { body: [], delayMs: 500 } });
  try {
    await assert.rejects(new GitHubClient(GH_TOKEN, { baseUrl: stub.url, timeoutMs: 50 }).recentDeployments("slow", since), (e) => e instanceof ToolError && e.code === "backend_timeout");
    const ac = new AbortController();
    const p = new GitHubClient(GH_TOKEN, { baseUrl: stub.url }).recentDeployments("slow", since, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p, (e) => e instanceof ToolError && e.code === "cancelled");
  } finally {
    await stub.close();
  }
});

test("repository names are validated before any request", async () => {
  const stub = await startGitHubStub({});
  try {
    const client = new GitHubClient(GH_TOKEN, { baseUrl: stub.url });
    for (const bad of ["../x", "a/b/c", "a b", "x?y=1", "", "a/..", "x".repeat(101), "a#b", "a%2fb"]) {
      await assert.rejects(client.recentDeployments(bad, since), (e) => e instanceof ToolError && e.code === "invalid_param", bad);
    }
    assert.equal(stub.seen.length, 0);
  } finally {
    await stub.close();
  }
});

test("githubFromEnv: off without a file, a client with a token file, a warning when unreadable or empty, quiet for the unset placeholder", () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    assert.equal(githubFromEnv({}), undefined);
    assert.ok(githubFromEnv({ GH_DEPLOYMENTS_TOKEN_FILE: writeTemp("gh", `${GH_TOKEN}\n`) }) instanceof GitHubClient);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(githubFromEnv({ GH_DEPLOYMENTS_TOKEN_FILE: writeTemp("gh", "unset") }), undefined);
    assert.equal(warn.mock.callCount(), 0);
    assert.equal(githubFromEnv({ GH_DEPLOYMENTS_TOKEN_FILE: "/nonexistent/token" }), undefined);
    assert.equal(githubFromEnv({ GH_DEPLOYMENTS_TOKEN_FILE: writeTemp("gh", "  \n") }), undefined);
    assert.equal(warn.mock.callCount(), 2);
    assert.ok(!JSON.stringify(warn.mock.calls.map((c) => c.arguments)).includes(GH_TOKEN));
    assert.equal(process.env.GH_DEPLOYMENTS_TOKEN, undefined);
  } finally {
    warn.mock.restore();
  }
});

test("a rate limit or a 5xx serves the stale cache entry when there is one", async () => {
  let limited = false;
  const stub = await startGitHubStub({ ...routes, "/repos/barlito/carapp/deployments": () => (limited ? { status: 403, headers: { "retry-after": "30" } } : { body: routes["/repos/barlito/carapp/deployments"].body }) });
  try {
    const client = new GitHubClient(GH_TOKEN, { baseUrl: stub.url, cacheMs: 20 });
    await client.recentDeployments("carapp", since);
    limited = true;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await client.recentDeployments("carapp", since))[0]?.id, 2);
  } finally {
    await stub.close();
  }
});

test("statuses are only read for deployments created before the end of the window; an unreadable status keeps the deployment as unknown", async () => {
  const stub = await startGitHubStub({
    "/repos/barlito/carapp/deployments": { body: [apiDeployment(3, "v1.5.0", "2026-06-03T10:00:00Z"), apiDeployment(2, "v1.4.3", T0)] },
    "/repos/barlito/carapp/deployments/2/statuses": { status: 500 },
  });
  try {
    const list = await new GitHubClient(GH_TOKEN, { baseUrl: stub.url }).recentDeployments("carapp", since);
    assert.deepEqual(list.map((d) => [d.id, d.status]), [[2, "unknown"]]);
    assert.ok(!stub.seen.some((r) => r.path.includes("/deployments/3/")));
  } finally {
    await stub.close();
  }
});

test("a request budget caps the HTTP calls of one tool call; cache hits are free", async () => {
  const stub = await startGitHubStub(routes);
  try {
    const client = new GitHubClient(GH_TOKEN, { baseUrl: stub.url });
    const budget = new RequestBudget(1);
    const list = await client.recentDeployments("carapp", since, { budget });
    assert.equal(list[0]?.status, "unknown");
    assert.equal(budget.exhausted, true);
    assert.equal(stub.seen.length, 1);
    await client.recentDeployments("carapp", since, { budget });
    assert.equal(stub.seen.length, 1);
  } finally {
    await stub.close();
  }
});

test("a deployment of another environment is refused", async () => {
  const stub = await startGitHubStub({ "/repos/barlito/carapp/deployments/8": { body: { ...apiDeployment(8, "v1", T0), environment: "staging" } } });
  try {
    await assert.rejects(new GitHubClient(GH_TOKEN, { baseUrl: stub.url }).deployment("carapp", 8), (e) => e instanceof ToolError && e.code === "not_found");
  } finally {
    await stub.close();
  }
});

test("a missing repository is remembered: the second lookup costs no request", async () => {
  const stub = await startGitHubStub({});
  try {
    const client = new GitHubClient(GH_TOKEN, { baseUrl: stub.url });
    const budget = new RequestBudget(5);
    for (let i = 0; i < 3; i++) await assert.rejects(client.recentDeployments("ghost", since, { budget }), (e) => e instanceof ToolError && e.code === "not_found");
    assert.equal(stub.seen.length, 1);
    assert.equal(budget.remaining, 4);
  } finally {
    await stub.close();
  }
});
