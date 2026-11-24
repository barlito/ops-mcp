import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import type { GhDeployment } from "../github/GitHubClient";

export const GH_TOKEN = "github_pat_11AAAAAAA0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab";

// Shapes of the GitHub REST API (trimmed to what matters, same field names).
export const apiDeployment = (id: number, ref: string, createdAt: string, sha = "9fceb02d0ae598e95dc970b74767f19372d61af8") => ({
  url: `https://api.github.com/repos/barlito/carapp/deployments/${id}`,
  id,
  node_id: `DE_${id}`,
  sha,
  ref,
  task: "deploy",
  payload: {},
  original_environment: "production",
  environment: "production",
  description: null,
  creator: { login: "github-actions[bot]", id: 41898282, type: "Bot" },
  created_at: createdAt,
  updated_at: createdAt,
  statuses_url: `https://api.github.com/repos/barlito/carapp/deployments/${id}/statuses`,
  repository_url: "https://api.github.com/repos/barlito/carapp",
  transient_environment: false,
  production_environment: true,
});

export const apiStatus = (state: string, runId: number, createdAt: string) => ({
  url: "https://api.github.com/repos/barlito/carapp/deployments/1/statuses/1",
  id: 1,
  state,
  creator: { login: "github-actions[bot]" },
  description: "",
  environment: "production",
  target_url: `https://github.com/barlito/carapp/actions/runs/${runId}`,
  log_url: `https://github.com/barlito/carapp/actions/runs/${runId}`,
  created_at: createdAt,
});

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}

// Routes are matched on the path without the query string.
export async function startGitHubStub(routes: Record<string, Reply | ((seen: Seen) => Reply)>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const entry: Seen = { path: req.url ?? "", headers: req.headers };
    seen.push(entry);
    const route = routes[entry.path.split("?")[0]!];
    const reply: Reply = typeof route === "function" ? route(entry) : (route ?? { status: 404, body: { message: "Not Found" } });
    setTimeout(() => {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
    }, reply.delayMs ?? 0);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

export const ghDeployment = (over: Partial<GhDeployment> & { id: number }): GhDeployment => ({
  ref: "v1.4.3",
  sha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
  created_at: "2026-06-01T11:40:00Z",
  creator: "github-actions[bot]",
  status: "success",
  run_url: `https://github.com/barlito/carapp/actions/runs/${over.id}`,
  ...over,
});
