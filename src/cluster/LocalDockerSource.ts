import { ToolError } from "../tools/contract";
import type { CallOptions, ClusterInfo, ClusterSource } from "./ClusterSource";
import { type RawNode, type RawService, type RawTask, sanitizeNode, sanitizeServiceDetail, sanitizeServiceSummary, sanitizeTask, sanitizeUpdate } from "./sanitize";
import { groupStacks } from "./swarm";
import { type NodeInfo, type ServiceDetail, type ServiceFilter, type ServiceSummary, type ServiceUpdate, type StackInfo, STACK_LABEL, type TaskFilter, type TaskInfo } from "./types";

const TIMEOUT_MS = 5000;

function withFilters(path: string, filters: Record<string, string[]>, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(extra);
  if (Object.keys(filters).length > 0) params.set("filters", JSON.stringify(filters));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

// Talks to a docker-socket-proxy (read-only endpoints) over plain HTTP.
export class LocalDockerSource implements ClusterSource {
  private readonly base: string;

  constructor(
    url: string,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    this.base = url.replace(/^tcp:\/\//, "http://");
  }

  private async get<T>(path: string, opts: CallOptions = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(this.timeoutMs)]) });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const reason = e.name === "TimeoutError" ? `timeout after ${this.timeoutMs} ms` : (e.cause?.code ?? e.message);
      throw new ToolError("server_unreachable", `Docker API unreachable: ${reason}`);
    }
    if (res.status === 404) throw new ToolError("not_found", `${path.split("?")[0]} not found`);
    if (!res.ok) throw new ToolError("server_unreachable", `${path.split("?")[0]} answered HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async info(opts?: CallOptions): Promise<ClusterInfo> {
    try {
      const version = await this.get<{ Version?: string }>("/version", opts);
      const info = await this.get<{ Swarm?: { LocalNodeState?: string } }>("/info", opts);
      return { reachable: true, dockerVersion: version.Version, swarm: info.Swarm?.LocalNodeState === "active" };
    } catch (err) {
      return { reachable: false, swarm: false, error: (err as Error).message };
    }
  }

  async listNodes(opts?: CallOptions): Promise<NodeInfo[]> {
    return (await this.get<RawNode[]>("/nodes", opts)).map(sanitizeNode);
  }

  async listServices(filter: ServiceFilter = {}, opts?: CallOptions): Promise<ServiceSummary[]> {
    const filters: Record<string, string[]> = {};
    if (filter.stack) filters.label = [`${STACK_LABEL}=${filter.stack}`];
    if (filter.service) filters.name = [filter.service];
    const services = (await this.get<RawService[]>(withFilters("/services", filters, { status: "true" }), opts)).map((s) => sanitizeServiceSummary(s));
    // Docker's name filter is a substring match.
    return filter.service ? services.filter((s) => s.name === filter.service || s.id === filter.service) : services;
  }

  async listStacks(opts?: CallOptions): Promise<StackInfo[]> {
    return groupStacks(await this.listServices({}, opts));
  }

  private async inspect(idOrName: string, opts?: CallOptions): Promise<RawService> {
    try {
      return await this.get<RawService>(`/services/${encodeURIComponent(idOrName)}`, opts);
    } catch (err) {
      if (err instanceof ToolError && err.code === "not_found") throw new ToolError("not_found", `Service "${idOrName}" not found. Use the full name, e.g. <stack>_<service>.`);
      throw err;
    }
  }

  async getService(idOrName: string, opts?: CallOptions): Promise<ServiceDetail> {
    const raw = await this.inspect(idOrName, opts);
    const [listed] = await this.get<RawService[]>(withFilters("/services", { id: [raw.ID] }, { status: "true" }), opts);
    return sanitizeServiceDetail(raw, listed?.ServiceStatus);
  }

  async serviceUpdateHistory(idOrName: string, opts?: CallOptions): Promise<ServiceUpdate> {
    return sanitizeUpdate(await this.inspect(idOrName, opts));
  }

  async listTasks(filter: TaskFilter, opts?: CallOptions): Promise<TaskInfo[]> {
    const [services, nodes] = await Promise.all([this.listServices({}, opts), this.listNodes(opts)]);
    let scoped = services;
    if (filter.stack) scoped = scoped.filter((s) => s.stack === filter.stack);
    if (filter.service) {
      scoped = scoped.filter((s) => s.name === filter.service || s.id === filter.service);
      if (scoped.length === 0) throw new ToolError("not_found", `Service "${filter.service}" not found${filter.stack ? ` in stack "${filter.stack}"` : ""}.`);
    }
    if ((filter.stack || filter.service) && scoped.length === 0) return [];
    const filters: Record<string, string[]> = filter.stack || filter.service ? { service: scoped.map((s) => s.id) } : {};
    const raw = await this.get<RawTask[]>(withFilters("/tasks", filters), opts);
    const serviceNames = new Map(services.map((s) => [s.id, s.name]));
    const nodeNames = new Map(nodes.map((n) => [n.id, n.hostname]));
    return raw
      .map((t) => sanitizeTask(t, serviceNames, nodeNames))
      .filter((t) => filter.state === undefined || t.state === filter.state)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  }
}
