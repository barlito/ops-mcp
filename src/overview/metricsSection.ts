import { z } from "zod";
import { eq } from "../metrics/labels";
import { cpuPct, diskUsedPct, ramPct } from "../metrics/nodeQueries";
import { errorMessage, redact } from "../platform/util";
import type { OverviewSection } from "./section";

const PartSchema = z.object({
  cpu_pct: z.number().nullable(),
  ram_pct: z.number().nullable(),
  disk_max_pct: z.number().nullable(),
  error: z.string().optional(),
});
type Part = z.infer<typeof PartSchema>;

const round = (v: number | undefined): number | null => (v === undefined ? null : Math.round(v * 10) / 10);

export const metricsSection: OverviewSection<Part> = {
  name: "metrics",
  partSchema: PartSchema,
  async collect(ctx, servers, window) {
    const parts = new Map<string, Part>();
    await Promise.all(
      servers.map(async (server) => {
        const sel = eq("server", server.slug);
        try {
          const [cpu, ram, disk] = await Promise.all([
            ctx.prom.query(`avg(${cpuPct(sel, "5m")})`, window.to),
            ctx.prom.query(`avg(${ramPct(sel)})`, window.to),
            ctx.prom.query(`max(${diskUsedPct(sel)})`, window.to),
          ]);
          parts.set(server.slug, { cpu_pct: round(cpu[0]?.value), ram_pct: round(ram[0]?.value), disk_max_pct: round(disk[0]?.value) });
        } catch (err) {
          parts.set(server.slug, { cpu_pct: null, ram_pct: null, disk_max_pct: null, error: redact(errorMessage(err)) });
        }
      }),
    );
    return parts;
  },
  summarize(parts) {
    const fmt = (v: number | null): string => (v === null ? "n/a" : `${v}%`);
    return [...parts].map(([slug, p]) => `${slug}: cpu ${fmt(p.cpu_pct)}, ram ${fmt(p.ram_pct)}, disk max ${fmt(p.disk_max_pct)}${p.error ? ` (${p.error})` : ""}`).join("; ");
  },
};
