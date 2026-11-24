import { z } from "zod";
import { groupStacks, imageLabel, isDegraded } from "../cluster/swarm";
import { REPO_LABEL } from "../cluster/types";
import { defineTool, envelopeSchema, resolveServers, scopeShape } from "./contract";
import { failureNote, fanOut } from "./fanOut";

const ItemSchema = z.object({
  server: z.string(),
  stack: z.string(),
  project: z.string().nullable(),
  services: z.number(),
  state: z.enum(["running", "degraded"]),
  degraded: z.array(z.string()),
  images: z.array(z.string()),
  last_update: z.string(),
});
type Item = z.infer<typeof ItemSchema>;

export const opsListStacks = defineTool({
  name: "ops_list_stacks",
  description:
    "List the Swarm stacks of one or every server with their project, service count, health (all running or which services are degraded), images:tags and last update. Use it to see what runs where and spot a stack with missing replicas; follow with ops_get_service or ops_list_tasks on a degraded one.",
  inputSchema: z.object({ server: scopeShape.server }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (s: Item) => `${s.server} ${s.stack} project=${s.project ?? "-"} services=${s.services} ${s.state}${s.degraded.length ? ` [${s.degraded.join(", ")}]` : ""} images=${s.images.join(",")} updated=${s.last_update}`,
  async handler(args, ctx) {
    const { ok, failed } = await fanOut(ctx, resolveServers(ctx.registry, args.server), (source) => source.listServices({}, { signal: ctx.signal }));
    const items: Item[] = ok.flatMap(({ server, value }) =>
      groupStacks(value).map((stack) => {
        const degraded = stack.services.filter(isDegraded).map((s) => `${s.name} ${s.running}/${s.desired}`);
        return {
          server: server.slug,
          stack: stack.name,
          project: stack.services.find((s) => s.labels[REPO_LABEL])?.labels[REPO_LABEL] ?? ctx.registry.stack_projects[stack.name] ?? null,
          services: stack.services.length,
          state: degraded.length === 0 ? ("running" as const) : ("degraded" as const),
          degraded,
          images: [...new Set(stack.services.map((s) => imageLabel(s.image)))].sort(),
          last_update: stack.services.map((s) => s.updated_at).sort().at(-1) ?? "",
        };
      }),
    );
    const degradedCount = items.filter((i) => i.state === "degraded").length;
    return { summary: `${items.length} stack${items.length === 1 ? "" : "s"}, ${degradedCount} degraded${failureNote(failed)}`, items };
  },
});
