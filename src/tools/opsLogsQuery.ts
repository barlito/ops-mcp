import { z } from "zod";
import { fetchEntries } from "../logs/fetch";
import { cleanLine } from "../logs/fingerprint";
import { DAY_MS } from "../logs/patterns";
import { isoNs, toNs } from "../logs/time";
import { LEVELS, levelFilter, lineFilters, logQuery, selector } from "../logs/selector";
import { clampWindow, cursorParam, decodeCursor, defineTool, encodeCursor, envelopeSchema, limitParam, resolveServers, resolveWindow, scopeShape } from "./contract";

const ItemSchema = z.object({ ts: z.string(), server: z.string(), service: z.string(), level: z.string(), line: z.string() });
type Item = z.infer<typeof ItemSchema>;
const CursorSchema = z.object({ ns: z.string().regex(/^\d{1,20}$/) });

export const opsLogsQuery = defineTool({
  name: "ops_logs_query",
  description:
    "Search container logs (Loki) by server, stack, service, substring (contains), RE2 regex and level. Lines are redacted and cut to 400 characters, newest first by default; window capped at 24h. Follow next_cursor to page.",
  inputSchema: z.object({
    ...scopeShape,
    contains: z.string().optional().describe("Case-sensitive substring the line must contain."),
    regex: z.string().optional().describe("RE2 regex the line must match (no lookaround or backreferences)."),
    level: z.enum(LEVELS).optional().describe("Exact detected log level."),
    limit: limitParam(50, 200),
    direction: z.enum(["backward", "forward"]).default("backward").describe("backward = newest first, forward = oldest first."),
    cursor: cursorParam,
  }),
  outputSchema: envelopeSchema(ItemSchema),
  formatItem: (i: Item) => `${i.ts} ${i.server} ${i.service} ${i.level}: ${i.line}`,
  async handler(args, ctx) {
    resolveServers(ctx.registry, args.server);
    const window = clampWindow(resolveWindow(args, ctx.now()), DAY_MS);
    const query = logQuery(selector(args), lineFilters(args), args.level ? levelFilter([args.level]) : undefined);
    let start = toNs(window.from);
    let end = toNs(window.to);
    if (args.cursor) {
      const after = BigInt(decodeCursor(args.cursor, CursorSchema).ns);
      if (args.direction === "backward") end = after;
      else start = after + 1n;
    }
    const found = await fetchEntries(ctx.loki, { query, start, end, limit: args.limit + 1, direction: args.direction });
    const page = found.slice(0, args.limit);
    const items: Item[] = page.map((e) => ({ ts: isoNs(e.ns), server: e.server, service: e.service, level: e.level, line: cleanLine(e.line) }));
    return {
      summary: `${items.length} line${items.length === 1 ? "" : "s"}${window.clamped ? " (window capped at 24h)" : ""}`,
      items,
      truncated: found.length > args.limit,
      next_cursor: (kept) => (kept > 0 ? encodeCursor({ ns: String(page[kept - 1]!.ns) }) : undefined),
      window,
    };
  },
});
