import { z } from "zod";
import { withSignal } from "../logs/LokiClient";
import { fetchEntries } from "../logs/fetch";
import { cleanLine } from "../logs/fingerprint";
import { quote } from "../logs/selector";
import { isoNs, parseNs } from "../logs/time";
import { defineTool, envelopeSchema, nameParam, resolveServers } from "./contract";

const DAY_NS = 86_400_000_000_000n;
const MAX_SIDE = 50;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const ItemSchema = z.object({ ts: z.string(), level: z.string(), line: z.string() });
type Item = z.infer<typeof ItemSchema>;

export const opsLogsContext = defineTool({
  name: "ops_logs_context",
  description: "Lines logged by one service around an instant (a few before, the line at that instant and a few after), oldest first. Use the ts of a line from ops_logs_query. Lines are redacted and cut to 400 characters.",
  inputSchema: z.object({
    server: nameParam.describe("Server slug (see ops_list_servers)."),
    service: nameParam.describe("Full Swarm service name, e.g. carapp_php."),
    ts: z.string().regex(RFC3339_RE, "ts must be an RFC 3339 timestamp").describe("The instant, RFC 3339 (nanosecond precision accepted)."),
    before: z.number().int().min(0).max(MAX_SIDE).default(10).describe(`Lines before the instant (default 10, max ${MAX_SIDE}).`),
    after: z.number().int().min(0).max(MAX_SIDE).default(10).describe(`Lines after the instant (default 10, max ${MAX_SIDE}).`),
  }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (i: Item) => `${i.ts} ${i.level}: ${i.line}`,
  async handler(args, ctx) {
    const loki = withSignal(ctx.loki, ctx.signal);
    resolveServers(ctx.registry, args.server);
    const at = parseNs(args.ts);
    const query = `{server=${quote(args.server, "server")}, service_name=${quote(args.service, "service")}}`;
    const [before, after] = await Promise.all([
      args.before === 0 ? [] : fetchEntries(loki, { query, start: at - DAY_NS, end: at, limit: args.before, direction: "backward" }),
      fetchEntries(loki, { query, start: at, end: at + DAY_NS, limit: args.after + 1, direction: "forward" }),
    ]);
    const items: Item[] = [...before.reverse(), ...after].map((e) => ({ ts: isoNs(e.ns), level: e.level, line: cleanLine(e.line) }));
    return {
      summary: `${items.length} line${items.length === 1 ? "" : "s"} around ${args.ts} in ${args.service}`,
      items,
      window: { from: new Date(Number((at - DAY_NS) / 1_000_000n)), to: new Date(Number((at + DAY_NS) / 1_000_000n)) },
    };
  },
});
