import { ToolError } from "../tools/contract";

const MAX_LOOKBACK_MS = 7 * 86_400_000;
const UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000, y: 365 * 86_400_000 };

export interface AnalyzedLogql {
  // The query without comments, ready to send.
  query: string;
  isLog: boolean;
}

// Splits the query into comment-free text and a copy with string bodies blanked, so keyword checks
// never trip on (or are hidden by) string contents or comments.
function scan(logql: string): { query: string; code: string } {
  let query = "";
  let code = "";
  for (let i = 0; i < logql.length; i++) {
    const c = logql[i]!;
    if (c === "#") {
      while (i < logql.length && logql[i] !== "\n") i++;
      query += "\n";
      code += "\n";
    } else if (c === '"' || c === "`") {
      let j = i + 1;
      while (j < logql.length && logql[j] !== c) j += c === '"' && logql[j] === "\\" ? 2 : 1;
      query += logql.slice(i, j + 1);
      code += `${c}${c}`;
      i = j;
    } else {
      query += c;
      code += c;
    }
  }
  return { query, code };
}

function durationMs(text: string): number | undefined {
  if (!/^(?:\d+(?:ns|us|µs|ms|s|m|h|d|w|y))+$/.test(text)) return undefined;
  let total = 0;
  for (const m of text.matchAll(/(\d+)(ns|us|µs|ms|s|m|h|d|w|y)/g)) total += Number(m[1]) * UNIT_MS[m[2]!]!;
  return total;
}

export function analyzeLogql(logql: string): AnalyzedLogql {
  const { query, code } = scan(logql);
  if (/\b(?:line_format|label_format)\b/.test(code)) throw new ToolError("invalid_param", "line_format and label_format are not allowed: they could rewrite lines or labels around redaction.");
  const isLog = query.trimStart().startsWith("{");
  if (!isLog && /\|\s*(?:regexp|pattern)\b/.test(code)) throw new ToolError("invalid_param", "The regexp and pattern parsers are only allowed in log queries: in metric queries they could move a secret into a label.");
  const lookbacks = [...code.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!.split(":")[0]!.trim()).concat([...code.matchAll(/\boffset\s+([0-9a-zµ]+)/g)].map((m) => m[1]!));
  for (const d of lookbacks) {
    const ms = durationMs(d);
    if (ms !== undefined && ms > MAX_LOOKBACK_MS) throw new ToolError("invalid_param", `Range and offset durations are limited to 7d, got ${d}.`);
  }
  return { query, isLog };
}
