import { z } from "zod";
import { redactAll } from "../platform/redact/secrets";
import { errorMessage } from "../platform/util";
import type { Scope } from "../tools/contract";
import type { AlertSource, CallOptions, PromAlert } from "./PromClient";

const MAX_TEXT_CHARS = 300;
const MAX_LABEL_CHARS = 200;

export const AlertItemSchema = z.object({
  source: z.enum(["prometheus", "grafana"]),
  name: z.string(),
  state: z.string(),
  severity: z.string().optional(),
  summary: z.string().optional(),
  reason: z.string().optional(),
  active_since: z.string().optional(),
  value: z.string().optional(),
  labels: z.record(z.string(), z.string()),
});
export type AlertItem = z.infer<typeof AlertItemSchema>;

const ACTIVE_STATES: Record<string, string> = { firing: "firing", alerting: "firing", pending: "pending", nodata: "nodata", error: "error" };

const truncate = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

// Grafana states read `Alerting (NoData)`: the first word is the state, the rest is the reason.
const isWellFormed = (a: PromAlert): boolean => typeof a?.state === "string" && Boolean(a.labels) && typeof a.labels === "object";

export function toAlertItem(source: AlertItem["source"], a: PromAlert): AlertItem | undefined {
  if (!isWellFormed(a)) return undefined;
  const [word = "", ...rest] = a.state.trim().split(/\s+/);
  const state = ACTIVE_STATES[word.toLowerCase()];
  if (!state) return undefined;
  const reason = rest.join(" ").replace(/^\(|\)$/g, "");
  const summary = a.annotations?.summary ?? a.annotations?.description;
  const labels = Object.fromEntries(Object.entries(a.labels).map(([k, v]) => [k, truncate(String(v), MAX_LABEL_CHARS)]));
  return {
    source,
    name: labels.alertname ?? "(unnamed)",
    state,
    ...(labels.severity ? { severity: labels.severity } : {}),
    ...(summary ? { summary: truncate(summary, MAX_TEXT_CHARS) } : {}),
    ...(reason ? { reason: truncate(reason, MAX_LABEL_CHARS) } : {}),
    ...(a.activeAt ? { active_since: a.activeAt } : {}),
    ...(a.value !== undefined ? { value: truncate(String(a.value), MAX_LABEL_CHARS) } : {}),
    labels,
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
  // Sources that answered, and one sentence per source that is missing, failed or sent unusable alerts.
  sources: string[];
  notes: string[];
}

const stateRank = (s: string): number => (s === "firing" ? 0 : s === "pending" ? 1 : 2);

// Prometheus is required; Grafana is optional and its failure only costs a note.
export async function collectAlerts(prom: AlertSource, grafana: AlertSource | undefined, opts?: CallOptions): Promise<CollectedAlerts> {
  const [fromProm, fromGrafana] = await Promise.allSettled([prom.alerts(opts), grafana ? grafana.alerts(opts) : Promise.resolve([])]);
  if (fromProm.status === "rejected") throw fromProm.reason;
  const sources = ["prometheus"];
  const notes: string[] = [];
  const raw: Array<[AlertItem["source"], PromAlert]> = fromProm.value.map((a) => ["prometheus", a]);
  if (!grafana) notes.push("Grafana alerts not included (not configured)");
  else if (fromGrafana.status === "rejected") notes.push(`Grafana alerts unavailable: ${redactAll(errorMessage(fromGrafana.reason))}`);
  else {
    sources.push("grafana");
    raw.push(...fromGrafana.value.map((a): [AlertItem["source"], PromAlert] => ["grafana", a]));
  }
  const malformed = raw.filter(([, a]) => !isWellFormed(a)).length;
  if (malformed > 0) notes.push(`${malformed} malformed alert(s) skipped`);
  const alerts = raw.flatMap(([source, a]) => toAlertItem(source, a) ?? []).sort((a, b) => stateRank(a.state) - stateRank(b.state) || a.name.localeCompare(b.name));
  return { alerts, sources, notes };
}
