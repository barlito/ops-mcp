import { z } from "zod";
import { collectAlerts } from "../metrics/alerts";
import type { OverviewSection } from "./section";

const MAX_NAMES = 10;

const PartSchema = z.object({ firing: z.number(), names: z.array(z.string()) });
type Part = z.infer<typeof PartSchema>;

export const alertsSection: OverviewSection<Part> = {
  name: "alerts",
  partSchema: PartSchema,
  async collect(ctx, servers) {
    const { alerts } = await collectAlerts(ctx.prom, ctx.grafana, { signal: ctx.signal });
    return new Map(
      servers.map((server) => {
        const firing = alerts.filter((a) => a.state === "firing" && a.labels.server === server.slug);
        return [server.slug, { firing: firing.length, names: [...new Set(firing.map((a) => a.name))].slice(0, MAX_NAMES) }];
      }),
    );
  },
  summarize(parts) {
    return [...parts].map(([slug, p]) => `${slug}: ${p.firing === 0 ? "no firing alert" : `${p.firing} firing (${p.names.join(", ")})`}`).join("; ");
  },
};
