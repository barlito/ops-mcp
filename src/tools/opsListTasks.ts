import { z } from "zod";
import { TaskSchema } from "../cluster/types";
import { ToolError, decodeCursor, defineTool, encodeCursor, envelopeSchema, limitParam, resolveServers, cursorParam } from "./contract";

const TASK_STATES = ["new", "pending", "assigned", "accepted", "preparing", "ready", "starting", "running", "complete", "failed", "shutdown", "rejected", "orphaned", "remove"] as const;
type Item = z.infer<typeof TaskSchema>;

const CursorSchema = z.object({ offset: z.number().int().min(0) });

export const opsListTasks = defineTool({
  name: "ops_list_tasks",
  description:
    "List the Swarm tasks (container instances) of a stack or a service, newest first, with state, desired state, error message, exit code, node and timestamps. Use it to see why replicas are missing or restarting (failed, rejected) and when it started; filter with state=failed. Give stack or service.",
  inputSchema: z.object({
    server: z.string().describe("Server slug (see ops_list_servers)."),
    stack: z.string().optional().describe("Swarm stack name."),
    service: z.string().optional().describe("Full Swarm service name, e.g. carapp_php."),
    state: z.enum(TASK_STATES).optional().describe("Only tasks currently in this state."),
    limit: limitParam(20, 50),
    cursor: cursorParam,
  }),
  outputSchema: envelopeSchema(TaskSchema),
  formatItem: (t: Item) => `${t.updated_at} ${t.service}${t.slot === undefined ? "" : `.${t.slot}`} ${t.state}->${t.desired_state}${t.node ? ` node=${t.node}` : ""}${t.error ? ` error="${t.error}"` : ""}${t.exit_code === undefined ? "" : ` exit=${t.exit_code}`}`,
  async handler(args, ctx) {
    if (args.stack === undefined && args.service === undefined) throw new ToolError("invalid_arguments", "Give stack or service.");
    const [server] = resolveServers(ctx.registry, args.server);
    const offset = args.cursor === undefined ? 0 : decodeCursor(args.cursor, CursorSchema).offset;
    const tasks = await ctx.cluster(server!).listTasks({ stack: args.stack, service: args.service, state: args.state }, { signal: ctx.signal });
    const items = tasks.slice(offset, offset + args.limit);
    return {
      summary: `${tasks.length} task${tasks.length === 1 ? "" : "s"}${args.state ? ` in state ${args.state}` : ""}, showing ${items.length} from ${offset}`,
      items,
      truncated: offset + args.limit < tasks.length,
      next_cursor: (kept) => encodeCursor({ offset: offset + kept }),
    };
  },
});
