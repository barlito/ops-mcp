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
const MISSING_MS = 10 * 60_000;

export const isRepoName = (name: string): boolean => REPO_PART.test(name) && name !== "." && name !== "..";
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

// Caps the HTTP requests of one tool call; cache hits are free.
export class RequestBudget {
  exhausted = false;

  constructor(public remaining: number) {}

  take(): boolean {
    if (this.remaining <= 0) {
      this.exhausted = true;
      return false;
    }
    this.remaining--;
    return true;
  }
}

export interface GhCallOptions {
  signal?: AbortSignal;
  budget?: RequestBudget;
}

export interface GitHubApi {
  // `repo` is a name or owner/name. Newest first, created inside the window, with their latest status
  // (only fetched for deployments created before `to`; "unknown" when it cannot be read).
  recentDeployments(repo: string, window: { from: Date; to: Date }, opts?: GhCallOptions): Promise<GhDeployment[]>;
  deployment(repo: string, id: number, opts?: GhCallOptions): Promise<GhDeployment>;
}

const DeploymentSchema = z.object({ id: z.number(), environment: z.string(), ref: z.string(), sha: z.string(), created_at: z.string(), creator: z.object({ login: z.string() }).nullish() });
const StatusSchema = z.object({ state: z.string(), log_url: z.string().nullish(), target_url: z.string().nullish() });

interface CacheEntry {
  at: number;
  etag?: string;
  body: unknown;
}

export class GitHubClient implements GitHubApi {
  private readonly limiter: SlotLimiter;
  private readonly cache = new Map<string, CacheEntry>();
  // Paths that answered 404, remembered so a guessed repository costs one request per period.
  private readonly missing = new Map<string, number>();
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

  async recentDeployments(repo: string, window: { from: Date; to: Date }, opts?: GhCallOptions): Promise<GhDeployment[]> {
    const base = this.repoPath(repo);
    const list = z.array(DeploymentSchema).safeParse(await this.get(`${base}/deployments?environment=production&per_page=${LIST_SIZE}`, opts));
    if (!list.success) throw unexpected();
    const inWindow = list.data.filter((d) => Date.parse(d.created_at) >= window.from.getTime() && Date.parse(d.created_at) <= window.to.getTime());
    return Promise.all(inWindow.slice(0, MAX_STATUS_LOOKUPS).map((d) => this.withStatus(base, d, opts).catch((err: unknown) => this.unknownStatus(d, err))));
  }

  async deployment(repo: string, id: number, opts?: GhCallOptions): Promise<GhDeployment> {
    const base = this.repoPath(repo);
    const parsed = DeploymentSchema.safeParse(await this.get(`${base}/deployments/${id}`, opts));
    if (!parsed.success) throw unexpected();
    if (parsed.data.environment !== "production") throw new ToolError("not_found", "That GitHub deployment is not a production deployment.");
    return this.withStatus(base, parsed.data, opts).catch((err: unknown) => this.unknownStatus(parsed.data, err));
  }

  // A status that cannot be read keeps the deployment, with status "unknown"; a cancelled call still aborts.
  private unknownStatus(d: z.infer<typeof DeploymentSchema>, err: unknown): GhDeployment {
    if (err instanceof ToolError && err.code === "cancelled") throw err;
    return { ...this.toDeployment(d), status: "unknown" };
  }

  private toDeployment(d: z.infer<typeof DeploymentSchema>): GhDeployment {
    return { id: d.id, ref: redactAll(d.ref), sha: d.sha, created_at: d.created_at, ...(d.creator ? { creator: redactAll(d.creator.login) } : {}), status: "pending" };
  }

  private async withStatus(base: string, d: z.infer<typeof DeploymentSchema>, opts?: GhCallOptions): Promise<GhDeployment> {
    const statuses = z.array(StatusSchema).safeParse(await this.get(`${base}/deployments/${d.id}/statuses?per_page=1`, opts));
    if (!statuses.success) throw unexpected();
    const latest = statuses.data[0];
    const url = [latest?.log_url, latest?.target_url].find((u): u is string => typeof u === "string" && RUN_URL.test(u));
    return { ...this.toDeployment(d), status: redactAll(latest?.state ?? "pending"), ...(url ? { run_url: url } : {}) };
  }

  private repoPath(repo: string): string {
    const parts = repo.split("/");
    const [owner, name] = parts.length === 2 ? parts : [this.owner, repo];
    if (parts.length > 2 || ![owner!, name!].every(isRepoName)) {
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
  private async get(path: string, opts?: GhCallOptions): Promise<unknown> {
    const signal = opts?.signal;
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.body;
    if ((this.missing.get(path) ?? 0) > Date.now()) throw failure(404, new Headers());
    if (opts?.budget && !opts.budget.take()) throw new ToolError("backend_unavailable", "GitHub request budget of this call reached.");
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
      if (status !== 200 || body === undefined) {
        const err = failure(status, headers);
        if (status === 404) this.missing.set(path, Date.now() + MISSING_MS);
        // Rate limit and 5xx: a stale answer beats none.
        if (cached && err.code === "backend_unavailable") return cached.body;
        throw err;
      }
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
  const remaining = headers.get("x-ratelimit-remaining");
  if (status === 429 || (status === 403 && (headers.has("retry-after") || remaining === null || remaining === "0"))) return new ToolError("backend_unavailable", "GitHub rate limit exceeded, retry later.");
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
