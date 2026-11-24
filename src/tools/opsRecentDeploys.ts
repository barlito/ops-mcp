import { z } from "zod";
import { imageLabel, timeOf } from "../cluster/swarm";
import { ToolError, defineTool, envelopeSchema, limitParam, resolveServers, resolveWindow, scopeShape } from "./contract";
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
  failed_image: z.string().optional(),
});
type Item = z.infer<typeof ItemSchema>;

export const opsRecentDeploys = defineTool({
  name: "ops_recent_deploys",
  description:
    "List the services updated in the window (newest first) with their update state (completed, rollback_completed, paused), message, and the image before and after. Use it to answer 'what changed recently' when something started failing. Swarm keeps only the last update of each service. After an automatic rollback Swarm restores the old spec and forgets the failed one: image is then the restored version and failed_image the version that failed, taken from recent failed tasks. previous_image is the image before the update otherwise (also after a manual rollback).",
  inputSchema: z.object({ server: scopeShape.server, since: scopeShape.since, until: scopeShape.until, limit: limitParam(10, 20) }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (d: Item) => `${d.at} ${d.server} ${d.service} ${d.previous_image ? `${d.previous_image} -> ` : ""}${d.image}${d.state ? ` ${d.state}` : ""}${d.failed_image ? ` (failed: ${d.failed_image})` : ""}${d.message ? ` "${d.message}"` : ""}`,
  async handler(args, ctx) {
    const window = resolveWindow(args, ctx.now());
    const { ok, failed } = await fanOut(ctx, resolveServers(ctx.registry, args.server), (source) => source.listServices({}, { signal: ctx.signal }));
    const inWindow = (updatedAt: string): boolean => timeOf(updatedAt) >= window.from.getTime() && timeOf(updatedAt) <= window.to.getTime();
    const recent = ok
      .flatMap(({ server, value }) => value.filter((s) => inWindow(s.updated_at)).map((s) => ({ server, service: s })))
      .sort((a, b) => timeOf(b.service.updated_at) - timeOf(a.service.updated_at) || a.service.name.localeCompare(b.service.name));
    const settled = await Promise.allSettled(
      recent.slice(0, args.limit).map(async ({ server, service }): Promise<Item> => {
        const update = await ctx.cluster(server).serviceUpdateHistory(service.id, { signal: ctx.signal });
        return {
          server: server.slug,
          service: update.service,
          ...(update.stack === undefined ? {} : { stack: update.stack }),
          at: update.updated_at,
          ...(update.update_status ? { state: update.update_status.state } : {}),
          ...(update.update_status?.message ? { message: update.update_status.message } : {}),
          image: imageLabel(update.image),
          ...(update.previous_image ? { previous_image: imageLabel(update.previous_image) } : {}),
          ...(update.failed_image ? { failed_image: imageLabel(update.failed_image) } : {}),
        };
      }),
    );
    // A service removed since the listing is simply gone from the deploys.
    const items = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const lookupFailures = settled.filter((r) => r.status === "rejected" && !(r.reason instanceof ToolError && r.reason.code === "not_found")).length;
    return {
      summary: `${recent.length} service update${recent.length === 1 ? "" : "s"} in the window${failureNote(failed)}${lookupFailures ? `; ${lookupFailures} lookup${lookupFailures === 1 ? "" : "s"} failed` : ""}`,
      items,
      truncated: recent.length > args.limit,
      window,
    };
  },
});
