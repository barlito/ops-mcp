import { redactSecrets } from "../platform/redact/secrets";
import { ToolError } from "../tools/contract";
import { backendJson } from "./http";
import { readFileSync } from "node:fs";
import type { AlertSource, CallOptions, PromAlert } from "./PromClient";

// Grafana Alerting's Prometheus-compatible endpoint (service account with the Viewer role).
export class GrafanaClient implements AlertSource {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async alerts(opts?: CallOptions): Promise<PromAlert[]> {
    const { status, body } = await backendJson("Grafana", `${this.baseUrl.replace(/\/+$/, "")}/api/prometheus/grafana/api/v1/alerts`, {
      headers: { authorization: `Bearer ${this.token}` },
      timeoutMs: this.timeoutMs,
      signal: opts?.signal,
    });
    const b = body as { status?: string; data?: { alerts?: PromAlert[] }; message?: string } | undefined;
    if (status === 200 && b?.status === "success") return b.data?.alerts ?? [];
    throw new ToolError("backend_unavailable", `Grafana answered HTTP ${status}${b?.message ? `: ${redactSecrets(b.message).slice(0, 200)}` : ""}.`);
  }
}

export function grafanaFromEnv(env: NodeJS.ProcessEnv): GrafanaClient | undefined {
  const url = env.GRAFANA_URL?.trim();
  const file = env.GRAFANA_TOKEN_FILE?.trim();
  const token = file ? readFileSync(file, "utf8").trim() : undefined;
  return url && token ? new GrafanaClient(url, token) : undefined;
}
