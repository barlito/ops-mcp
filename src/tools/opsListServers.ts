import { z } from "zod";
import type { ClusterInfo } from "../cluster/ClusterSource";
import { errorMessage } from "../platform/util";
import type { ServerEntry } from "../registry";
import { defineTool, envelopeSchema } from "./contract";

const ItemSchema = z.object({
  server: z.string(),
  env: z.string(),
  kind: z.string(),
  tenant: z.string(),
  reachable: z.boolean(),
  docker_version: z.string().optional(),
  error: z.string().optional(),
});
type Item = z.infer<typeof ItemSchema>;

export const opsListServers = defineTool({
  name: "ops_list_servers",
  description:
    "List the servers known to ops-mcp (slug, environment, kind, tenant) and whether each one is reachable right now. Start here to get the server slugs the other tools accept.",
  inputSchema: z.object({}),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (s: Item) => `${s.server} env=${s.env} kind=${s.kind} tenant=${s.tenant} ${s.reachable ? `up docker=${s.docker_version ?? "?"}` : `DOWN ${s.error ?? ""}`}`.trim(),
  async handler(_args, ctx) {
    const probe = async (server: ServerEntry): Promise<ClusterInfo> => {
      try {
        return await ctx.cluster(server).info({ signal: ctx.signal });
      } catch (err) {
        return { reachable: false, swarm: false, error: errorMessage(err) };
      }
    };
    const infos = await Promise.all(ctx.registry.servers.map(probe));
    const items: Item[] = ctx.registry.servers.map((s, i) => {
      const info = infos[i]!;
      return {
        server: s.slug,
        env: s.env,
        kind: s.kind,
        tenant: s.tenant,
        reachable: info.reachable,
        ...(info.dockerVersion ? { docker_version: info.dockerVersion } : {}),
        ...(info.error ? { error: info.error } : {}),
      };
    });
    const up = items.filter((i) => i.reachable).length;
    return { summary: `${items.length} server${items.length === 1 ? "" : "s"}, ${up} reachable`, items };
  },
});
