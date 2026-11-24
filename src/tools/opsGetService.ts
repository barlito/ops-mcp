import { z } from "zod";
import { ServiceDetailSchema, TaskSchema } from "../cluster/types";
import { defineTool, envelopeSchema, resolveServers } from "./contract";

const MAX_TASKS = 10;

const ItemSchema = ServiceDetailSchema.extend({ server: z.string(), tasks: z.array(TaskSchema) });
type Item = z.infer<typeof ItemSchema>;

export const opsGetService = defineTool({
  name: "ops_get_service",
  description:
    "Inspect one Swarm service: image and tag, replicas running/desired, last update status (rollback, failure), published ports, routes, placement constraints, resource limits, whitelisted labels, and its 10 most recent tasks with their errors and exit codes. Environment variables and secret values are never returned. Use it to find out why a service is down or what it runs.",
  inputSchema: z.object({
    server: z.string().describe("Server slug (see ops_list_servers)."),
    service: z.string().describe("Full Swarm service name, e.g. carapp_php."),
  }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (s: Item) =>
    `${s.server} ${s.name} ${s.running}/${s.desired} ${s.mode} image=${s.image.name}:${s.image.tag ?? "-"}${s.update_status ? ` update=${s.update_status.state}` : ""}\n${s.tasks.map((t) => `  ${t.updated_at} ${t.state}->${t.desired_state}${t.error ? ` error="${t.error}"` : ""}${t.exit_code === undefined ? "" : ` exit=${t.exit_code}`}`).join("\n")}`,
  async handler(args, ctx) {
    const [server] = resolveServers(ctx.registry, args.server);
    const source = ctx.cluster(server!);
    const [service, tasks] = await Promise.all([source.getService(args.service), source.listTasks({ service: args.service })]);
    return {
      summary: `${service.name} ${service.running}/${service.desired} running${service.update_status ? `, last update ${service.update_status.state}` : ""}`,
      items: [{ ...service, server: server!.slug, tasks: tasks.slice(0, MAX_TASKS) }],
    };
  },
});
