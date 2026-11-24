import { z } from "zod";
import { imageLabel } from "../cluster/swarm";
import { defineTool, envelopeSchema, limitParam, resolveServers, resolveWindow, scopeShape } from "./contract";
import { failureNote, fanOut } from "./fanOut";

const ItemSchema = z.object({
  server: z.string(),
  service: z.string(),
  stack: z.string().optional(),
  at: z.string(),
  state: z.string().optional(),
  message: z.string().optional(),
  image: z.string(),
  previous_image: z.string().optional(),
});
type Item = z.infer<typeof ItemSchema>;

export const opsRecentDeploys = defineTool({
  name: "ops_recent_deploys",
  description:
    "List the services updated in the window (newest first) with their update state (completed, rollback_completed, paused), message, and the image before and after. Use it to answer 'what changed recently' when something started failing. Swarm keeps only the last update of each service. An update that rolled back shows the rolled-back image as previous_image.",
  inputSchema: z.object({ server: scopeShape.server, since: scopeShape.since, until: scopeShape.until, limit: limitParam(10, 20) }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (d: Item) => `${d.at} ${d.server} ${d.service} ${d.previous_image ? `${d.previous_image} -> ` : ""}${d.image}${d.state ? ` ${d.state}` : ""}${d.message ? ` "${d.message}"` : ""}`,
  async handler(args, ctx) {
    const window = resolveWindow(args, ctx.now());
    const { ok, failed } = await fanOut(ctx, resolveServers(ctx.registry, args.server), (source) => source.listServices());
    const recent = ok
      .flatMap(({ server, value }) => value.filter((s) => Date.parse(s.updated_at) >= window.from.getTime() && Date.parse(s.updated_at) <= window.to.getTime()).map((s) => ({ server: server.slug, service: s })))
      .sort((a, b) => b.service.updated_at.localeCompare(a.service.updated_at) || a.service.name.localeCompare(b.service.name));
    const items = await Promise.all(
      recent.slice(0, args.limit).map(async ({ server, service }): Promise<Item> => {
        const update = await ctx.cluster(ctx.registry.servers.find((s) => s.slug === server)!).serviceUpdateHistory(service.id);
        return {
          server,
          service: update.service,
          ...(update.stack === undefined ? {} : { stack: update.stack }),
          at: update.updated_at,
          ...(update.update_status ? { state: update.update_status.state } : {}),
          ...(update.update_status?.message ? { message: update.update_status.message } : {}),
          image: imageLabel(update.image),
          ...(update.previous_image ? { previous_image: imageLabel(update.previous_image) } : {}),
        };
      }),
    );
    return {
      summary: `${recent.length} service update${recent.length === 1 ? "" : "s"} in the window${failureNote(failed)}`,
      items,
      truncated: recent.length > args.limit,
      window,
    };
  },
});
