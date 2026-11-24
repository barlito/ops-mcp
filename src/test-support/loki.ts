import type { InstantParams, LokiApi, LokiData, LokiStream, RangeParams } from "../logs/LokiClient";

export interface FakeLine {
  ns: bigint;
  line: string;
  labels?: Record<string, string>;
}

const BASE = { server: "ovh-prod-1", service_name: "carapp_php", detected_level: "error" };

// Serves canned lines honouring start/end/limit/direction and records every query it receives.
export class FakeLoki implements LokiApi {
  readonly ranges: RangeParams[] = [];
  readonly instants: InstantParams[] = [];
  instant: LokiData = { type: "series", series: [] };

  constructor(private readonly lines: FakeLine[] = []) {}

  async queryRange(p: RangeParams): Promise<LokiData> {
    this.ranges.push(p);
    const hit = this.lines.filter((l) => l.ns >= p.start && l.ns < p.end).sort((a, b) => (a.ns < b.ns ? -1 : 1));
    if (p.direction !== "forward") hit.reverse();
    const byLabels = new Map<string, LokiStream>();
    for (const l of hit.slice(0, p.limit)) {
      const labels = { ...BASE, ...l.labels };
      const key = JSON.stringify(labels);
      byLabels.set(key, byLabels.get(key) ?? { labels, values: [] });
      byLabels.get(key)!.values.push([l.ns, l.line]);
    }
    return { type: "streams", streams: [...byLabels.values()] };
  }

  async query(p: InstantParams): Promise<LokiData> {
    this.instants.push(p);
    return this.instant;
  }
}
