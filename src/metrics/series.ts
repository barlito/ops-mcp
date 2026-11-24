import { z } from "zod";
import type { TimeWindow } from "../tools/contract";
import type { PromSeries } from "./PromClient";

export const MAX_POINTS = 60;
export const SPARKLINE_POINTS = 30;
export const MAX_WINDOW_MS = 7 * 86_400_000;
// Prometheus is scraped every 15 s: finer steps add nothing.
const SCRAPE_SECONDS = 15;
const BARS = "▁▂▃▄▅▆▇█";

// Smallest step (a multiple of the scrape interval) that keeps a window within MAX_POINTS.
export function minStepSeconds(window: TimeWindow): number {
  const span = (window.to.getTime() - window.from.getTime()) / 1000;
  return Math.max(SCRAPE_SECONDS, Math.ceil(span / (MAX_POINTS - 1) / SCRAPE_SECONDS) * SCRAPE_SECONDS);
}

const sig = (v: number): number => Number(v.toPrecision(4));

// Mean of consecutive buckets, to at most `max` values.
export function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  return Array.from({ length: max }, (_, i) => {
    const bucket = values.slice(Math.floor((i * values.length) / max), Math.floor(((i + 1) * values.length) / max));
    return bucket.reduce((a, b) => a + b, 0) / bucket.length;
  });
}

export function sparkline(values: number[]): string {
  if (values.length < 2) return "";
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (hi === lo) return BARS[3]!.repeat(values.length);
  return values.map((v) => BARS[Math.round(((v - lo) / (hi - lo)) * (BARS.length - 1))]).join("");
}

export const MetricItemSchema = z.object({
  metric: z.string(),
  unit: z.string(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  avg: z.number().nullable(),
  last: z.number().nullable(),
  points: z.array(z.number()),
  sparkline: z.string(),
  note: z.string().optional(),
});
export type MetricItem = z.infer<typeof MetricItemSchema>;

export const NO_DATA = "no data: series not found (not running, not scraped, or name mismatch)";

export interface Stats {
  min: number | null;
  max: number | null;
  avg: number | null;
  last: number | null;
}

export function stats(values: number[]): Stats {
  if (values.length === 0) return { min: null, max: null, avg: null, last: null };
  return {
    min: sig(Math.min(...values)),
    max: sig(Math.max(...values)),
    avg: sig(values.reduce((a, b) => a + b, 0) / values.length),
    last: sig(values[values.length - 1]!),
  };
}

export const STALE = "last sample is older than the end of the window";

// `staleBefore` (unix seconds): a last sample older than it is flagged.
export function metricItem(metric: string, unit: string, series: PromSeries | undefined, emptyNote = NO_DATA, staleBefore?: number): MetricItem {
  const values = series?.points.map(([, v]) => v) ?? [];
  if (values.length === 0) return { metric, unit, ...stats(values), points: [], sparkline: "", note: emptyNote };
  const shown = downsample(values, SPARKLINE_POINTS).map(sig);
  const stale = staleBefore !== undefined && series!.points[series!.points.length - 1]![0] < staleBefore;
  return { metric, unit, ...stats(values), points: shown, sparkline: sparkline(shown), ...(stale ? { note: STALE } : {}) };
}

const fmt = (v: number | null): string => (v === null ? "n/a" : String(v));

export function formatMetric(i: MetricItem): string {
  const parts = [`${i.metric} (${i.unit})`, i.sparkline, `min=${fmt(i.min)} max=${fmt(i.max)} avg=${fmt(i.avg)} last=${fmt(i.last)}`, i.note ? `[${i.note}]` : ""];
  return parts.filter(Boolean).join(" ");
}
