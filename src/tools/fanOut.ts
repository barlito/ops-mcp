import type { ClusterSource } from "../cluster/ClusterSource";
import { redactAll } from "../platform/redact/secrets";
import { errorMessage } from "../platform/util";
import type { ServerEntry } from "../registry";
import { ToolError, type ToolContext } from "./contract";

export interface ServerFailure {
  server: string;
  error: string;
}

export interface FanOut<T> {
  ok: Array<{ server: ServerEntry; value: T }>;
  failed: ServerFailure[];
}

// Runs `fn` against every server in parallel. One failing server among several is reported, not
// thrown; a single targeted server that fails fails the call.
export async function fanOut<T>(ctx: ToolContext, servers: ServerEntry[], fn: (source: ClusterSource, server: ServerEntry) => Promise<T>): Promise<FanOut<T>> {
  const settled = await Promise.all(
    servers.map(async (server) => {
      try {
        return { server, value: await fn(ctx.cluster(server), server) };
      } catch (err) {
        return { server, err };
      }
    }),
  );
  const ok: FanOut<T>["ok"] = [];
  const failed: ServerFailure[] = [];
  for (const r of settled) {
    if ("err" in r) {
      if (servers.length === 1) throw r.err instanceof ToolError ? r.err : new ToolError("server_unreachable", redactAll(errorMessage(r.err)));
      failed.push({ server: r.server.slug, error: redactAll(errorMessage(r.err)) });
    } else ok.push(r);
  }
  return { ok, failed };
}

export const failureNote = (failed: ServerFailure[]): string => (failed.length === 0 ? "" : `; failed: ${failed.map((f) => f.server).join(", ")}`);
