import { z } from "zod";
import { collectAlerts } from "../metrics/alerts";
import type { OverviewSection } from "./section";

const MAX_NAMES = 10;

const PartSchema = z.object({
  firing: z.number(),
  names: z.array(z.string()),
  // Firing alerts carrying no `server` label (shown on every server) and source problems.
  firing_without_server: z.number(),
  names_without_server: z.array(z.string()),
  notes: z.array(z.string()),
  rules_configured: z.boolean(),
});
type Part = z.infer<typeof PartSchema>;

const names = (alerts: Array<{ name: string }>): string[] => [...new Set(alerts.map((a) => a.name))].slice(0, MAX_NAMES);

export const alertsSection: OverviewSection<Part> = {
  name: "alerts",
  partSchema: PartSchema,
  async collect(ctx, servers) {
    const { alerts, notes, noRules } = await collectAlerts(ctx.prom, ctx.grafana, { signal: ctx.signal });
    const firing = alerts.filter((a) => a.state === "firing");
    const unattributed = firing.filter((a) => a.labels.server === undefined);
    return new Map(
      servers.map((server) => {
        const own = firing.filter((a) => a.labels.server === server.slug);
        const part: Part = { firing: own.length, names: names(own), firing_without_server: unattributed.length, names_without_server: names(unattributed), notes, rules_configured: !noRules };
        return [server.slug, part];
      }),
    );
  },
  summarize(parts) {
    const lines = [...parts].map(([slug, p]) => {
      if (!p.rules_configured) return `${slug}: no alert rules configured`;
      if (p.firing > 0) return `${slug}: ${p.firing} firing (${p.names.join(", ")})`;
      const doubt = p.firing_without_server > 0 || p.notes.some((n) => n.includes("unavailable") || n.includes("malformed"));
      return `${slug}: ${doubt ? "none attributed to this server" : "no firing alert"}`;
    });
    const shared = new Set<string>();
    for (const p of parts.values()) {
      if (p.firing_without_server > 0) shared.add(`${p.firing_without_server} firing without server label (${p.names_without_server.join(", ")})`);
      for (const n of p.notes) shared.add(n);
    }
    return [...lines, ...shared].join("; ");
  },
};
