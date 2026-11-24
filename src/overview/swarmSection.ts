import { z } from "zod";
import { groupStacks, isDegraded } from "../cluster/swarm";
import { errorMessage } from "../platform/util";
import type { OverviewSection } from "./section";

const MAX_FAILED_TASKS = 10;
const FAILED_STATES = new Set(["failed", "rejected"]);

const OkSchema = z.object({
  nodes: z.object({ total: z.number(), not_ready: z.array(z.string()) }),
  stacks: z.number(),
  degraded_services: z.array(z.object({ service: z.string(), running: z.number(), desired: z.number() })),
  failed_tasks_total: z.number(),
  failed_tasks: z.array(z.object({ service: z.string(), error: z.string().optional(), exit_code: z.number().optional(), at: z.string() })),
});
const PartSchema = z.union([OkSchema, z.object({ error: z.string() })]);
export type SwarmPart = z.infer<typeof PartSchema>;

export const swarmSection: OverviewSection<SwarmPart> = {
  name: "swarm",
  partSchema: PartSchema,
  async collect(ctx, servers, window) {
    const entries = await Promise.all(
      servers.map(async (server): Promise<[string, SwarmPart]> => {
        try {
          const source = ctx.cluster(server);
          const [nodes, services, tasks] = await Promise.all([source.listNodes(), source.listServices(), source.listTasks({})]);
          const failedTasks = tasks.filter((t) => FAILED_STATES.has(t.state) && Date.parse(t.updated_at) >= window.from.getTime() && Date.parse(t.updated_at) <= window.to.getTime());
          return [
            server.slug,
            {
              nodes: { total: nodes.length, not_ready: nodes.filter((n) => n.state !== "ready").map((n) => n.hostname) },
              stacks: groupStacks(services).length,
              degraded_services: services.filter(isDegraded).map((s) => ({ service: s.name, running: s.running, desired: s.desired })),
              failed_tasks_total: failedTasks.length,
              failed_tasks: failedTasks.slice(0, MAX_FAILED_TASKS).map((t) => ({
                service: t.service,
                ...(t.error ? { error: t.error } : {}),
                ...(t.exit_code === undefined ? {} : { exit_code: t.exit_code }),
                at: t.updated_at,
              })),
            },
          ];
        } catch (err) {
          return [server.slug, { error: errorMessage(err) }];
        }
      }),
    );
    return new Map(entries);
  },
  summarize(parts) {
    const all = [...parts.values()];
    const healthy = all.filter((p): p is z.infer<typeof OkSchema> => !("error" in p));
    const degraded = healthy.reduce((n, p) => n + p.degraded_services.length, 0);
    const failedTasks = healthy.reduce((n, p) => n + p.failed_tasks_total, 0);
    const unreachable = all.length - healthy.length;
    return `swarm: ${degraded} degraded service${degraded === 1 ? "" : "s"}, ${failedTasks} failed task${failedTasks === 1 ? "" : "s"}${unreachable ? `, ${unreachable} server${unreachable === 1 ? "" : "s"} unreachable` : ""}`;
  },
};
