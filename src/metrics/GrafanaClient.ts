import { redactAll } from "../platform/redact/secrets";
import { errorMessage } from "../platform/util";
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
    throw new ToolError("backend_unavailable", `Grafana answered HTTP ${status}${b?.message ? `: ${redactAll(b.message).slice(0, 200)}` : ""}.`);
  }
}

// Unset URL: Grafana is off. Unreadable token: warn once and answer every call with an error that ops_alerts reports as a note.
export function grafanaFromEnv(env: NodeJS.ProcessEnv): AlertSource | undefined {
  const url = env.GRAFANA_URL?.trim();
  if (!url) return undefined;
  const file = env.GRAFANA_TOKEN_FILE?.trim();
  try {
    const token = file ? readFileSync(file, "utf8").trim() : "";
    if (!token) throw new Error("no token");
    return new GrafanaClient(url, token);
  } catch (err) {
    console.warn(`Grafana alerts disabled: cannot read GRAFANA_TOKEN_FILE (${redactAll(errorMessage(err))})`);
    return { alerts: () => Promise.reject(new ToolError("backend_unavailable", "Grafana token file is missing or unreadable")) };
  }
}
