import type { z } from "zod";
import type { ServerEntry } from "../registry";
import type { TimeWindow, ToolContext } from "../tools/contract";

// One slice of ops_overview, filled by its own phase. `collect` returns one part per server slug.
export interface OverviewSection<P> {
  name: "swarm" | "logs" | "metrics" | "alerts";
  partSchema: z.ZodType<P>;
  collect(ctx: ToolContext, servers: ServerEntry[], window: TimeWindow): Promise<Map<string, P>>;
  summarize(parts: Map<string, P>): string;
}
