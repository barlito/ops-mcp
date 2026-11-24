import type { TimeWindow } from "../tools/contract";
import type { LokiApi } from "./LokiClient";
import { type Level, levelFilter, levelsFrom, logQuery, type LogScope, selector } from "./selector";
import { toNs } from "./time";

// Lines at `min` or above in the window; no matching stream is a count of 0.
export async function countLines(loki: LokiApi, scope: LogScope, min: Level, window: TimeWindow): Promise<number> {
  const seconds = Math.ceil((window.to.getTime() - window.from.getTime()) / 1000);
  const inner = logQuery(selector(scope), levelFilter(levelsFrom(min)));
  const data = await loki.query({ query: `sum(count_over_time(${inner} [${seconds}s]))`, time: toNs(window.to) });
  return data.type === "series" ? Math.round(Number(data.series[0]?.points[0]?.[1] ?? 0)) : 0;
}
