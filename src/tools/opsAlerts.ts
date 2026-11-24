import { z } from "zod";
import { AlertItemSchema, collectAlerts, inScope, type AlertItem } from "../metrics/alerts";
import { defineTool, envelopeSchema, resolveServers, scopeShape } from "./contract";

const inputSchema = z.object({ server: scopeShape.server, stack: scopeShape.stack, service: scopeShape.service });

const formatItem = (a: AlertItem): string =>
  `${a.state} ${a.name}${a.severity ? ` [${a.severity}]` : ""} (${a.source})${a.active_since ? ` since ${a.active_since}` : ""}${a.summary ? `: ${a.summary}` : ""}`;

export const opsAlerts = defineTool({
  name: "ops_alerts",
  description:
    "Active alerts (firing, pending, no-data, error) from Prometheus and, when configured, Grafana Alerting. Filters match the alert labels server, service_namespace (stack) and service_name (service); an alert without that label is left out of a filtered result.",
  inputSchema,
  outputSchema: envelopeSchema(AlertItemSchema),
  formatItem,
  async handler(args, ctx) {
    if (args.server) resolveServers(ctx.registry, args.server);
    const { alerts, sources, notes, noRules } = await collectAlerts(ctx.prom, ctx.grafana, { signal: ctx.signal });
    const items = alerts.filter((a) => inScope(a, args));
    const firing = items.filter((a) => a.state === "firing").length;
    const pending = items.filter((a) => a.state === "pending").length;
    if (noRules) return { summary: ["No alert rules configured, so no alert can fire", ...notes].join(". "), items };
    return { summary: [`${firing} firing, ${pending} pending, ${items.length - firing - pending} other (sources: ${sources.join(", ")})`, ...notes].join(". "), items };
  },
});
