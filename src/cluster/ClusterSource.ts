import type { ServerEntry } from "../registry";
import { LocalDockerSource } from "./LocalDockerSource";
import type { NodeInfo, ServiceDetail, ServiceFilter, ServiceSummary, ServiceUpdate, StackInfo, TaskFilter, TaskInfo } from "./types";

export interface ClusterInfo {
  reachable: boolean;
  dockerVersion?: string;
  swarm: boolean;
  error?: string;
}

// Read-only view of one server's cluster. Every result is sanitized (no env values, secrets or
// unlisted labels); failures are ToolError "server_unreachable" or "not_found".
export interface CallOptions {
  signal?: AbortSignal;
}

export interface ClusterSource {
  info(opts?: CallOptions): Promise<ClusterInfo>;
  listNodes(opts?: CallOptions): Promise<NodeInfo[]>;
  listStacks(opts?: CallOptions): Promise<StackInfo[]>;
  listServices(filter?: ServiceFilter, opts?: CallOptions): Promise<ServiceSummary[]>;
  getService(idOrName: string, opts?: CallOptions): Promise<ServiceDetail>;
  // Newest first.
  listTasks(filter: TaskFilter, opts?: CallOptions): Promise<TaskInfo[]>;
  serviceUpdateHistory(idOrName: string, opts?: CallOptions): Promise<ServiceUpdate>;
}

export type ClusterSourceProvider = (server: ServerEntry) => ClusterSource;

export class UnsupportedSourceError extends Error {}

export function createClusterSource(server: ServerEntry): ClusterSource {
  switch (server.source.type) {
    case "local":
      return new LocalDockerSource(server.source.url);
    case "agent":
      throw new UnsupportedSourceError(`source type "agent" is not implemented (server ${server.slug})`);
  }
}

// One source per server for the process lifetime.
export function cachedClusterSources(create: ClusterSourceProvider = createClusterSource): ClusterSourceProvider {
  const cache = new Map<string, ClusterSource>();
  return (server) => {
    let s = cache.get(server.slug);
    if (!s) {
      s = create(server);
      cache.set(server.slug, s);
    }
    return s;
  };
}
