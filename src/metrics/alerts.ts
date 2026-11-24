import { z } from "zod";
import type { Scope } from "../tools/contract";
import type { AlertSource, PromAlert } from "./PromClient";
import { errorMessage, redact } from "../platform/util";

const MAX_TEXT_CHARS = 300;

export const AlertItemSchema = z.object({
  source: z.enum(["prometheus", "grafana"]),
  name: z.string(),
  state: z.string(),
  severity: z.string().optional(),
  summary: z.string().optional(),
  active_since: z.string().optional(),
  value: z.string().optional(),
  labels: z.record(z.string(), z.string()),
});
export type AlertItem = z.infer<typeof AlertItemSchema>;

const ACTIVE_STATES: Record<string, string> = { firing: "firing", alerting: "firing", pending: "pending", nodata: "nodata", error: "error" };

export function toAlertItem(source: AlertItem["source"], a: PromAlert): AlertItem | undefined {
  const state = ACTIVE_STATES[a.state.toLowerCase()];
  if (!state) return undefined;
  const summary = a.annotations?.summary ?? a.annotations?.description;
  return {
    source,
    name: a.labels.alertname ?? "(unnamed)",
    state,
    ...(a.labels.severity ? { severity: a.labels.severity } : {}),
    ...(summary ? { summary: summary.slice(0, MAX_TEXT_CHARS) } : {}),
    ...(a.activeAt ? { active_since: a.activeAt } : {}),
    ...(a.value !== undefined ? { value: a.value } : {}),
    labels: a.labels,
  };
}

export function inScope(alert: AlertItem, scope: Scope): boolean {
  return (
    (scope.server === undefined || alert.labels.server === scope.server) &&
    (scope.stack === undefined || alert.labels.service_namespace === scope.stack) &&
    (scope.service === undefined || alert.labels.service_name === scope.service)
  );
}

export interface CollectedAlerts {
  alerts: AlertItem[];
  // Sources that answered, and one sentence per source that is missing or failed.
  sources: string[];
  notes: string[];
}

const stateRank = (s: string): number => (s === "firing" ? 0 : s === "pending" ? 1 : 2);

// Prometheus is required; Grafana is optional and its failure only costs a note.
export async function collectAlerts(prom: AlertSource, grafana: AlertSource | undefined): Promise<CollectedAlerts> {
  const [fromProm, fromGrafana] = await Promise.allSettled([prom.alerts(), grafana ? grafana.alerts() : Promise.resolve([])]);
  if (fromProm.status === "rejected") throw fromProm.reason;
  const sources = ["prometheus"];
  const notes: string[] = [];
  let all = fromProm.value.map((a) => toAlertItem("prometheus", a));
  if (!grafana) notes.push("Grafana alerts not included (GRAFANA_URL/GRAFANA_TOKEN not configured)");
  else if (fromGrafana.status === "rejected") notes.push(`Grafana alerts unavailable: ${redact(errorMessage(fromGrafana.reason))}`);
  else {
    sources.push("grafana");
    all = all.concat(fromGrafana.value.map((a) => toAlertItem("grafana", a)));
  }
  const alerts = all.filter((a): a is AlertItem => a !== undefined).sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.name.localeCompare(b.name));
  return { alerts, sources, notes };
}
