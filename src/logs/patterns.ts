import type { TimeWindow } from "../tools/contract";
import { sampleEntries } from "./fetch";
import { type PatternGroup, groupPatterns } from "./fingerprint";
import type { LokiApi } from "./LokiClient";
import { LEVELS, type Level, levelFilter, levelsFrom, logQuery, type LogScope, selector } from "./selector";
import { toNs } from "./time";

export const DAY_MS = 86_400_000;
const rank = (level: string): number => LEVELS.indexOf(level as Level);

// Most severe first, then most frequent.
export function topPatterns(groups: PatternGroup[], n: number): PatternGroup[] {
  return [...groups].sort((a, b) => rank(b.level) - rank(a.level) || b.count - a.count).slice(0, n);
}

export async function levelPatterns(loki: LokiApi, scope: LogScope, min: Level, window: TimeWindow): Promise<PatternGroup[]> {
  const query = logQuery(selector(scope), levelFilter(levelsFrom(min)));
  return groupPatterns(await sampleEntries(loki, query, toNs(window.from), toNs(window.to)));
}
