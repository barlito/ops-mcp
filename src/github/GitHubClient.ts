import { readFileSync } from "node:fs";
import { z } from "zod";
import { backendJson } from "../metrics/http";
import { SlotLimiter } from "../platform/slotLimiter";
import { redactAll } from "../platform/redact/secrets";
import { errorMessage } from "../platform/util";
import { ToolError } from "../tools/contract";

const DEFAULT_OWNER = "barlito";
const API_URL = "https://api.github.com";
const LIST_SIZE = 30;
const MAX_STATUS_LOOKUPS = 10;
const MAX_CACHE_ENTRIES = 200;
const QUEUE_WAIT_MS = 5000;
const QUEUE_POLL_MS = 25;
const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;
const RUN_URL = /^https:\/\/github\.com\//;

export interface GhDeployment {
  id: number;
  ref: string;
  sha: string;
  created_at: string;
  creator?: string;
  // Latest status state: success, failure, error, inactive, in_progress, queued, pending.
  status: string;
  run_url?: string;
}

export interface GitHubApi {
  // `repo` is a name or owner/name. Newest first, created at or after `since`, with their latest status.
  recentDeployments(repo: string, since: Date, opts?: { signal?: AbortSignal }): Promise<GhDeployment[]>;
  deployment(repo: string, id: number, opts?: { signal?: AbortSignal }): Promise<GhDeployment>;
}

const DeploymentSchema = z.object({ id: z.number(), ref: z.string(), sha: z.string(), created_at: z.string(), creator: z.object({ login: z.string() }).nullish() });
const StatusSchema = z.object({ state: z.string(), log_url: z.string().nullish(), target_url: z.string().nullish() });

interface CacheEntry {
  at: number;
  etag?: string;
  body: unknown;
}

export class GitHubClient implements GitHubApi {
  private readonly limiter: SlotLimiter;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly owner: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;

  constructor(
    private readonly token: string,
    config: { owner?: string; baseUrl?: string; timeoutMs?: number; slots?: number; cacheMs?: number } = {},
  ) {
    this.owner = config.owner ?? DEFAULT_OWNER;
    this.baseUrl = (config.baseUrl ?? API_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.cacheMs = config.cacheMs ?? 60_000;
    this.limiter = new SlotLimiter(config.slots ?? 4);
  }

  async recentDeployments(repo: string, since: Date, opts?: { signal?: AbortSignal }): Promise<GhDeployment[]> {
    const base = this.repoPath(repo);
    const list = z.array(DeploymentSchema).safeParse(await this.get(`${base}/deployments?environment=production&per_page=${LIST_SIZE}`, opts?.signal));
    if (!list.success) throw unexpected();
    const recent = list.data.filter((d) => Date.parse(d.created_at) >= since.getTime()).slice(0, MAX_STATUS_LOOKUPS);
    return Promise.all(recent.map((d) => this.withStatus(base, d, opts?.signal)));
  }

  async deployment(repo: string, id: number, opts?: { signal?: AbortSignal }): Promise<GhDeployment> {
    const base = this.repoPath(repo);
    const parsed = DeploymentSchema.safeParse(await this.get(`${base}/deployments/${id}`, opts?.signal));
    if (!parsed.success) throw unexpected();
    return this.withStatus(base, parsed.data, opts?.signal);
  }

  private async withStatus(base: string, d: z.infer<typeof DeploymentSchema>, signal?: AbortSignal): Promise<GhDeployment> {
    const statuses = z.array(StatusSchema).safeParse(await this.get(`${base}/deployments/${d.id}/statuses?per_page=1`, signal));
    if (!statuses.success) throw unexpected();
    const latest = statuses.data[0];
    const url = [latest?.log_url, latest?.target_url].find((u): u is string => typeof u === "string" && RUN_URL.test(u));
    return {
      id: d.id,
      ref: redactAll(d.ref),
      sha: d.sha,
      created_at: d.created_at,
      ...(d.creator ? { creator: redactAll(d.creator.login) } : {}),
      status: redactAll(latest?.state ?? "pending"),
      ...(url ? { run_url: url } : {}),
    };
  }

  private repoPath(repo: string): string {
    const parts = repo.split("/");
    const [owner, name] = parts.length === 2 ? parts : [this.owner, repo];
    if (parts.length > 2 || ![owner!, name!].every((p) => REPO_PART.test(p) && p !== "." && p !== "..")) {
      throw new ToolError("invalid_param", "Repository must be a name or owner/name (letters, digits, _ . -).");
    }
    return `/repos/${owner}/${name}`;
  }

  // Waits a few seconds for a free slot instead of failing at once.
  private async acquire(signal?: AbortSignal): Promise<() => void> {
    const deadline = Date.now() + QUEUE_WAIT_MS;
    for (;;) {
      if (signal?.aborted) throw new ToolError("cancelled", "Request cancelled.");
      const release = this.limiter.acquire([]);
      if (release) return release;
      if (Date.now() >= deadline) throw new ToolError("backend_unavailable", "Too many concurrent GitHub requests, retry shortly.");
      await new Promise((r) => setTimeout(r, QUEUE_POLL_MS));
    }
  }

  // Fresh cache entries are served as is; stale ones are revalidated with If-None-Match (a 304 costs no rate limit).
  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.body;
    const release = await this.acquire(signal);
    try {
      const { status, body, headers } = await backendJson("GitHub", `${this.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ops-mcp", ...(cached?.etag ? { "if-none-match": cached.etag } : {}) },
        timeoutMs: this.timeoutMs,
        signal,
      });
      if (status === 304 && cached) {
        cached.at = Date.now();
        return cached.body;
      }
      if (status !== 200 || body === undefined) throw failure(status, headers);
      this.remember(path, { at: Date.now(), etag: headers.get("etag") ?? undefined, body });
      return body;
    } finally {
      release();
    }
  }

  private remember(path: string, entry: CacheEntry): void {
    this.cache.delete(path);
    this.cache.set(path, entry);
    if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }
}

const unexpected = (): ToolError => new ToolError("backend_unavailable", "GitHub returned an unexpected answer.");

// Upstream bodies are never echoed: they can carry token details.
function failure(status: number, headers: Headers): ToolError {
  if (status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0")) return new ToolError("backend_unavailable", "GitHub rate limit exceeded, retry later.");
  if (status === 401 || status === 403) return new ToolError("backend_auth", "GitHub refused the token (needs Deployments and Metadata read access on the repository).");
  if (status === 404) return new ToolError("not_found", "GitHub repository or deployment not found, or not visible to the token.");
  return new ToolError("backend_unavailable", `GitHub answered HTTP ${status}.`);
}

// No token file configured: feature off. A configured but unreadable or empty file warns once; the literal `unset` is the compose placeholder.
export function githubFromEnv(env: NodeJS.ProcessEnv): GitHubApi | undefined {
  const file = env.GH_DEPLOYMENTS_TOKEN_FILE?.trim();
  if (!file) return undefined;
  try {
    const token = readFileSync(file, "utf8").trim();
    if (token === "unset") return undefined;
    if (!token) throw new Error("empty token file");
    return new GitHubClient(token, { owner: env.GITHUB_OWNER?.trim() || undefined });
  } catch (err) {
    console.warn(`GitHub deployments disabled: cannot read GH_DEPLOYMENTS_TOKEN_FILE (${redactAll(errorMessage(err))})`);
    return undefined;
  }
}
