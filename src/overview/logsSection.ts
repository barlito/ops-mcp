import { z } from "zod";
import { DAY_MS, levelPatterns, topPatterns } from "../logs/patterns";
import { clampWindow, ToolError } from "../tools/contract";
import type { OverviewSection } from "./section";

const TOP = 5;

const PartSchema = z.object({
  patterns: z.array(z.object({ service: z.string(), level: z.string(), count: z.number(), pattern: z.string() })),
  error: z.string().optional(),
});
type Part = z.infer<typeof PartSchema>;

export const logsSection: OverviewSection<Part> = {
  name: "logs",
  partSchema: PartSchema,
  async collect(ctx, servers, window) {
    const sampleWindow = clampWindow(window, DAY_MS);
    const entries = await Promise.all(
      servers.map(async (s): Promise<[string, Part]> => {
        try {
          const groups = await levelPatterns(ctx.loki, { server: s.slug }, "error", sampleWindow);
          return [s.slug, { patterns: topPatterns(groups, TOP).map((g) => ({ service: g.service, level: g.level, count: g.count, pattern: g.pattern })) }];
        } catch (err) {
          if (!(err instanceof ToolError)) throw err;
          return [s.slug, { patterns: [], error: err.message }];
        }
      }),
    );
    return new Map(entries);
  },
  summarize(parts) {
    const lines = [...parts].map(([slug, p]) => {
      if (p.error) return `${slug}: logs unavailable (${p.error})`;
      const top = p.patterns[0];
      return `${slug}: ${p.patterns.length} error pattern${p.patterns.length === 1 ? "" : "s"}${top ? `, top ${top.service} x${top.count}` : ""}`;
    });
    return lines.join("; ");
  },
};
