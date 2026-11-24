import type { ClusterInfo, ClusterSource } from "./ClusterSource";

const TIMEOUT_MS = 3000;

// Talks to a docker-socket-proxy (read-only endpoints) over plain HTTP.
export class LocalDockerSource implements ClusterSource {
  private readonly base: string;

  constructor(
    url: string,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {
    this.base = url.replace(/^tcp:\/\//, "http://");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async info(): Promise<ClusterInfo> {
    try {
      const version = await this.get<{ Version?: string }>("/version");
      const info = await this.get<{ Swarm?: { LocalNodeState?: string } }>("/info");
      return { reachable: true, dockerVersion: version.Version, swarm: info.Swarm?.LocalNodeState === "active" };
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      return { reachable: false, swarm: false, error: e.name === "TimeoutError" ? `timeout after ${this.timeoutMs} ms` : (e.cause?.code ?? e.message) };
    }
  }
}
