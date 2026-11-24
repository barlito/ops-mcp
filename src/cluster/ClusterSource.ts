import type { ServerEntry } from "../registry";
import { LocalDockerSource } from "./LocalDockerSource";

export interface CallOptions {
  signal?: AbortSignal;
}

export interface ClusterInfo {
  reachable: boolean;
  dockerVersion?: string;
  swarm: boolean;
  error?: string;
}

// Read-only view of one server's cluster. Phase 2 adds the Swarm listing methods.
export interface ClusterSource {
  info(opts?: CallOptions): Promise<ClusterInfo>;
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
