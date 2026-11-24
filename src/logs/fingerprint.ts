import { redactAll } from "../platform/redact/secrets";

export const MAX_LINE_CHARS = 400;
const REDACT_INPUT_CHARS = 4000;

// Redacts first, then truncates, so a secret is never cut in half; the pre-slice bounds regex work.
export function cleanLine(line: string, max = MAX_LINE_CHARS): string {
  const out = redactAll(line.slice(0, REDACT_INPUT_CHARS));
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const RULES: [RegExp, string][] = [
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>"],
  [/(?<![\w:])(?=[0-9a-f:]*[0-9a-f])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, "<ip>"],
  [/\b(?:0x)?[0-9a-f]{8,}\b/gi, "<hex>"],
  [/"[^"\s]*"/g, '"<str>"'],
  [/(?<![\d.])\d+(?:\.\d+)*/g, "<n>"],
];

// Lines that differ only by ids, addresses, numbers, timestamps or quoted tokens share a pattern.
export function fingerprint(line: string): string {
  let out = line;
  for (const [re, label] of RULES) out = out.replace(re, label);
  return out.replace(/\s+/g, " ").trim();
}

export interface LogEntry {
  ns: bigint;
  server: string;
  service: string;
  level: string;
  line: string;
}

export interface PatternGroup {
  server: string;
  service: string;
  level: string;
  pattern: string;
  count: number;
  first: bigint;
  last: bigint;
  example: string;
}

const PATTERN_CHARS = 160;

// One group per (server, service, level, pattern); the example is the most recent redacted line.
export function groupPatterns(entries: LogEntry[], exampleChars = PATTERN_CHARS): PatternGroup[] {
  const groups = new Map<string, PatternGroup>();
  for (const e of entries) {
    const clean = cleanLine(e.line);
    const pattern = fingerprint(clean).slice(0, PATTERN_CHARS);
    const key = [e.server, e.service, e.level, pattern].join("\u0000");
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { server: e.server, service: e.service, level: e.level, pattern, count: 1, first: e.ns, last: e.ns, example: cleanLine(e.line, exampleChars) });
    } else {
      g.count++;
      if (e.ns < g.first) g.first = e.ns;
      if (e.ns > g.last) {
        g.last = e.ns;
        g.example = cleanLine(e.line, exampleChars);
      }
    }
  }
  return [...groups.values()];
}
