import { z } from "zod";
import { withSignal } from "../logs/LokiClient";
import { fetchEntries } from "../logs/fetch";
import { cleanLine } from "../logs/fingerprint";
import { DAY_MS } from "../logs/patterns";
import { isoNs, toNs } from "../logs/time";
import { LEVELS, levelFilter, lineFilters, logQuery, selector } from "../logs/selector";
import { clampWindow, cursorParam, decodeCursor, defineTool, encodeCursor, envelopeSchema, limitParam, resolveServers, resolveWindow, scopeShape } from "./contract";

const ItemSchema = z.object({ ts: z.string(), server: z.string(), service: z.string(), level: z.string(), line: z.string() });
type Item = z.infer<typeof ItemSchema>;
// `seen` = lines already returned at exactly `ns`, so lines sharing a timestamp are neither lost nor repeated.
const CursorSchema = z.object({ ns: z.string().regex(/^\d{1,20}$/), seen: z.number().int().min(0).max(1000) });

const MIN_MAX_BYTES = 1024;

// The first line of a page must fit the smallest max_bytes, otherwise a page could keep nothing and never advance.
function fitFirstLine(line: string, fixedBytes: number): string {
  const budget = MIN_MAX_BYTES - fixedBytes;
  let out = line;
  while (out.length > 0 && Buffer.byteLength(JSON.stringify(out)) > budget) out = out.slice(0, Math.floor(out.length * 0.8));
  return out;
}

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
    const loki = withSignal(ctx.loki, ctx.signal);
    resolveServers(ctx.registry, args.server);
    const window = clampWindow(resolveWindow(args, ctx.now()), DAY_MS);
    const query = logQuery(selector(args), lineFilters(args), args.level ? levelFilter([args.level]) : undefined);
    let start = toNs(window.from);
    let end = toNs(window.to);
    const cursor = args.cursor ? decodeCursor(args.cursor, CursorSchema) : undefined;
    const cursorNs = cursor ? BigInt(cursor.ns) : undefined;
    // A forged cursor may only narrow the window, never widen it.
    if (cursorNs !== undefined) {
      if (args.direction === "backward") end = end < cursorNs + 1n ? end : cursorNs + 1n;
      else start = start > cursorNs ? start : cursorNs;
    }
    const empty = { summary: "0 lines", items: [] as Item[], window };
    if (start >= end) return empty;

    const seen = cursor?.seen ?? 0;
    const found = await fetchEntries(loki, { query, start, end, limit: args.limit + 1 + seen, direction: args.direction });
    let skip = seen;
    const rest = found.filter((e) => !(e.ns === cursorNs && skip-- > 0));
    const page = rest.slice(0, args.limit);
    const fixed = Buffer.byteLength(JSON.stringify({ summary: "x".repeat(240), items: [{ ts: isoNs(0n), server: args.server ?? "", service: args.service ?? "", level: "critical", line: "" }], truncated: true, next_cursor: "x".repeat(120), window: { from: isoNs(0n), to: isoNs(0n) }, scope: { server: args.server, stack: args.stack, service: args.service } }));
    const items: Item[] = page.map((e, i) => ({ ts: isoNs(e.ns), server: e.server, service: e.service, level: e.level, line: i === 0 ? fitFirstLine(cleanLine(e.line), fixed) : cleanLine(e.line) }));
    return {
      summary: `${items.length} line${items.length === 1 ? "" : "s"}${window.clamped ? " (window capped at 24h)" : ""}`,
      items,
      truncated: rest.length > args.limit,
      next_cursor: (kept) => {
        if (kept === 0) return undefined;
        const last = page[kept - 1]!;
        const sameNs = page.slice(0, kept).filter((e) => e.ns === last.ns).length;
        return encodeCursor({ ns: String(last.ns), seen: sameNs + (last.ns === cursorNs ? seen : 0) });
      },
      window,
    };
  },
});
