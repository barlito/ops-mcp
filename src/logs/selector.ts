import { ToolError } from "../tools/contract";

export const LEVELS = ["trace", "debug", "info", "warn", "error", "critical", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

export const MAX_FILTER_CHARS = 200;
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/;
// Go RE2 (Loki) has no lookaround, backreferences, atomic groups or named-reference syntax.
const NON_RE2 = /\(\?(?:=|!|<=|<!|>|P=)|\\[1-9k]/;

// The only way a user string reaches LogQL: a double-quoted literal with \, " and newline escaped.
export function quote(value: string, what: string): string {
  if (CONTROL_CHARS.test(value)) throw new ToolError("invalid_param", `${what} contains a control character.`);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

export interface LogScope {
  server?: string;
  stack?: string;
  service?: string;
}

// At least one matcher is mandatory in LogQL, so a missing server falls back to "any server".
export function selector(scope: LogScope): string {
  const matchers = [
    scope.server === undefined ? 'server=~".+"' : `server=${quote(scope.server, "server")}`,
    ...(scope.stack === undefined ? [] : [`service_namespace=${quote(scope.stack, "stack")}`]),
    ...(scope.service === undefined ? [] : [`service_name=${quote(scope.service, "service")}`]),
  ];
  return `{${matchers.join(", ")}}`;
}

export function lineFilters(f: { contains?: string; regex?: string }): string {
  const parts: string[] = [];
  if (f.contains !== undefined) parts.push(`|= ${quote(boundedFilter(f.contains, "contains"), "contains")}`);
  if (f.regex !== undefined) {
    const re = boundedFilter(f.regex, "regex");
    if (NON_RE2.test(re)) throw new ToolError("invalid_param", "regex uses a construct RE2 does not support (lookaround, backreference, atomic group).");
    parts.push(`|~ ${quote(re, "regex")}`);
  }
  return parts.join(" ");
}

function boundedFilter(value: string, what: string): string {
  if (value.length === 0 || value.length > MAX_FILTER_CHARS) throw new ToolError("invalid_param", `${what} must be 1 to ${MAX_FILTER_CHARS} characters.`);
  return value;
}

export const levelsFrom = (min: Level): Level[] => LEVELS.slice(LEVELS.indexOf(min));

// detected_level is structured metadata: filtered after the stream selector.
export const levelFilter = (levels: Level[]): string => `| detected_level=~"${levels.join("|")}"`;

export const logQuery = (...parts: Array<string | undefined>): string => parts.filter(Boolean).join(" ");
