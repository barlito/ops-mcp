import { z } from "zod";
import { OVERVIEW_SECTIONS } from "../overview";
import type { OverviewSection } from "../overview/section";
import { swarmSection } from "../overview/swarmSection";
import { safeMessage } from "./fanOut";
import { defineTool, envelopeSchema, resolveServers, resolveWindow, scopeShape, type ToolDefinition } from "./contract";

const ItemSchema = z.object({
  server: z.string(),
  swarm: swarmSection.partSchema.optional(),
  logs: z.unknown().optional(),
  metrics: z.unknown().optional(),
  alerts: z.unknown().optional(),
  errors: z.record(z.string(), z.string()).optional(),
});
type Item = z.infer<typeof ItemSchema>;

type Collected = { section: OverviewSection<any>; parts: Map<string, unknown>; error?: undefined } | { section: OverviewSection<any>; error: string };

export function overviewTool(sections: OverviewSection<any>[]): ToolDefinition {
  return defineTool({
    name: "ops_overview",
    description:
      "One-call health summary per server: Swarm nodes, stacks, degraded services (running < desired) and tasks that failed in the window, plus log, metric and alert sections when available. Start here when asked 'is everything fine?' or when investigating, then drill down with ops_list_stacks, ops_get_service or ops_list_tasks. A section that cannot be collected is reported under errors, not as a failure.",
    inputSchema: z.object({ server: scopeShape.server, since: scopeShape.since, until: scopeShape.until }),
    outputSchema: envelopeSchema(ItemSchema),
    formatItem: (i: Item) => JSON.stringify(i),
    async handler(args, ctx) {
      const servers = resolveServers(ctx.registry, args.server);
      const window = resolveWindow(args, ctx.now());
      const collected = await Promise.all(
        sections.map(async (section): Promise<Collected> => {
          try {
            return { section, parts: await section.collect(ctx, servers, window) };
          } catch (err) {
            return { section, error: safeMessage(err) };
          }
        }),
      );
      const items: Item[] = servers.map((server) => {
        const item: Record<string, unknown> = { server: server.slug };
        const errors: Record<string, string> = {};
        for (const c of collected) {
          if (c.error !== undefined) errors[c.section.name] = c.error;
          else if (c.parts.has(server.slug)) item[c.section.name] = c.parts.get(server.slug);
          else errors[c.section.name] = "no data for this server";
        }
        return { ...item, ...(Object.keys(errors).length ? { errors } : {}) } as Item;
      });
      const lines = collected.map((c) => (c.error !== undefined ? `${c.section.name}: unavailable` : c.section.summarize(c.parts)));
      return { summary: `${servers.length} server${servers.length === 1 ? "" : "s"}; ${lines.join("; ")}`, items, window };
    },
  });
}

export const opsOverview = overviewTool(OVERVIEW_SECTIONS);
